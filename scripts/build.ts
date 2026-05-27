#!/usr/bin/env bun
/**
 * scripts/build.ts — build all 6 per-target hsh archives.
 *
 * # What this script produces
 *
 * One archive per (goos, goarch) target, each containing:
 *
 *   hsh              (or hsh.exe on windows): unprivileged CLI, Bun --compile
 *   hsh-tunneld      (or hsh-tunneld.exe): privileged daemon, from
 *                    hoophq/hoop GitHub Release (verified by SHA256)
 *   install.sh       wrapper script (Unix only — sh)
 *   uninstall.sh     wrapper script (Unix only)
 *
 * Unix targets are packaged as `hsh-<target>.tar.gz`; the Windows
 * target is packaged as `hsh-windows-x64.zip` (matching what
 * Explorer/PowerShell unpack natively).
 *
 * The output of a successful build:
 *
 *   dist/
 *     hsh-linux-x64.tar.gz
 *     hsh-linux-arm64.tar.gz
 *     hsh-darwin-x64.tar.gz
 *     hsh-darwin-arm64.tar.gz
 *     hsh-windows-x64.zip
 *     hsh-windows-arm64.zip
 *     SHA256SUMS              <- one line per archive
 *     .daemon-cache/<version>/...   <- internal, gitignored
 *     .stage/<target>/...           <- internal, gitignored
 *     daemon-version.json     <- the resolved daemon version we
 *                                bundled; consumed by src/version.ts
 *                                at runtime for `hsh --version`.
 *
 * # Pipeline
 *
 *   1. Resolve daemon version (env > src/daemon-version.ts > "latest"
 *      -> GitHub API call to get the concrete tag).
 *   2. Download SHA256SUMS from the hoop release.
 *   3. For each target:
 *       a. Build the hsh binary with `bun build --compile`.
 *       b. Download hsh-tunneld[+ install scripts] for the target,
 *          verify SHA256. (Scripts come from the same release; only
 *          downloaded once and reused across targets via the cache.)
 *       c. Stage hsh + daemon + scripts into dist/.stage/<target>/.
 *       d. tar/zip the staging dir into dist/<archive>.
 *   4. Generate SHA256SUMS over the archives.
 *
 * Failure handling: any error from steps 1–4 aborts the whole build
 * with `process.exit(1)`. We do NOT partial-publish; CI re-runs are
 * the right recovery path.
 */

import { $ } from "bun";
import { mkdirSync } from "fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { HSH_TUNNELD_VERSION } from "../src/daemon-version";
import {
  downloadTargetAssets,
  resolveRelease,
  type Target,
} from "./lib/daemon-download";
import { fileSize, makeTarGz, makeZip } from "./lib/archive";

/**
 * The full target matrix. Mirrors hoophq/hoop's build-hsh-tunneld-all
 * so every daemon target has a matching hsh target. Adding a target
 * here is the only step needed; everything else derives from this
 * list.
 */
interface BuildTarget extends Target {
  /** Bun's --target flag value. Distinct from the (goos, goarch) tuple
   * because Bun spells arm64 as "aarch64" and uses dashes. */
  bunTarget: string;
  /** Final archive filename (relative to dist/). */
  archive: string;
  /** Whether the hsh binary needs a .exe suffix. */
  exe: boolean;
}

const TARGETS: BuildTarget[] = [
  {
    goos: "linux",
    goarch: "amd64",
    bunTarget: "bun-linux-x64",
    archive: "hsh-linux-x64.tar.gz",
    exe: false,
  },
  {
    goos: "linux",
    goarch: "arm64",
    bunTarget: "bun-linux-arm64",
    archive: "hsh-linux-arm64.tar.gz",
    exe: false,
  },
  {
    goos: "darwin",
    goarch: "amd64",
    bunTarget: "bun-darwin-x64",
    archive: "hsh-darwin-x64.tar.gz",
    exe: false,
  },
  {
    goos: "darwin",
    goarch: "arm64",
    bunTarget: "bun-darwin-arm64",
    archive: "hsh-darwin-arm64.tar.gz",
    exe: false,
  },
  {
    goos: "windows",
    goarch: "amd64",
    bunTarget: "bun-windows-x64",
    archive: "hsh-windows-x64.zip",
    exe: true,
  },
  {
    goos: "windows",
    goarch: "arm64",
    bunTarget: "bun-windows-arm64",
    archive: "hsh-windows-arm64.zip",
    exe: true,
  },
];

const DIST = "dist";
const CACHE_ROOT = join(DIST, ".daemon-cache");
const STAGE_ROOT = join(DIST, ".stage");

/**
 * Main pipeline. Wrapped in an async IIFE because top-level await
 * in Bun is supported but we want a single try-catch boundary that
 * forces the non-zero exit on any failure.
 */
(async function main() {
  try {
    await build();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n\x1b[31m✗ build failed:\x1b[0m ${msg}\n`);
    process.exit(1);
  }
})();

async function build() {
  // Fresh start: nuke the dist/ contents (but not the gitignored
  // cache subdirectory, so iterative builds stay fast).
  await prepareDistDir();

  // 1. Resolve the daemon version. Env overrides constant. We hit
  // the GitHub API exactly once per build, then reuse the manifest
  // for every per-target download.
  const requested = process.env.HSH_TUNNELD_VERSION ?? HSH_TUNNELD_VERSION;
  console.log(`Bundling hsh-tunneld version: ${requested}`);
  const rel = await resolveRelease({
    version: requested,
    cacheRoot: CACHE_ROOT,
  });
  console.log(`Daemon version resolved to: ${rel.version}\n`);

  // 2. Run the per-target builds with the daemon-version-stamp.ts
  // file rewritten to the resolved concrete version. We do this
  // around a single try/finally so a failed target build still
  // restores the source file on its way out.
  await withStamp(rel.version, async () => {
    for (const t of TARGETS) {
      await buildTarget(t, rel);
    }
  });

  // 4. Final checksum over the archives. Consumers of the hsh
  // release (brew, RD-220) check this file rather than the
  // individual archives, so it's the trust root of the published
  // bundle.
  console.log("\nGenerating SHA256SUMS...");
  await $`cd ${DIST} && sha256sum ${TARGETS.map((t) => t.archive).join(" ")} > SHA256SUMS`.quiet();
  console.log(await Bun.file(join(DIST, "SHA256SUMS")).text());

  // Friendly final summary.
  console.log("Archives produced:");
  for (const t of TARGETS) {
    const path = join(DIST, t.archive);
    const sizeMB = (await fileSize(path)) / (1024 * 1024);
    console.log(`  ${t.archive.padEnd(28)} ${sizeMB.toFixed(1).padStart(5)} MB`);
  }
  console.log("\n\x1b[32m✓ build complete\x1b[0m");
}

/**
 * prepareDistDir resets the build output area while preserving the
 * gitignored caches. We deliberately do not `rm -rf dist/` because
 * that would invalidate `.daemon-cache/` and force a redownload of
 * the daemon for every iteration of every target.
 */
async function prepareDistDir() {
  mkdirSync(DIST, { recursive: true });
  // Remove every direct child of dist/ that isn't a cache or stage
  // directory. .daemon-cache and .stage stay; archives, raw binaries,
  // and previous SHA256SUMS go.
  const glob = new Bun.Glob("*");
  for await (const name of glob.scan({ cwd: DIST, dot: false, onlyFiles: false })) {
    if (name === ".daemon-cache" || name === ".stage") continue;
    await rm(join(DIST, name), { recursive: true, force: true });
  }
  await mkdir(STAGE_ROOT, { recursive: true });
}

/**
 * Build a single (goos, goarch) target end-to-end:
 *   bun --compile -> download daemon -> stage -> archive.
 */
async function buildTarget(t: BuildTarget, rel: Parameters<typeof downloadTargetAssets>[0]) {
  const targetName = `hsh-${t.goos}-${t.goarch === "amd64" ? "x64" : t.goarch}`;
  console.log(`==> ${targetName}`);

  // Per-target staging directory. We want the *contents* of the
  // archive to be `<targetName>/...`, so the archive helper takes
  // the staging dir whose basename is `<targetName>`.
  const stagingDir = join(STAGE_ROOT, targetName);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  // 1. Build hsh with Bun --compile.
  const hshOut = join(stagingDir, `hsh${t.exe ? ".exe" : ""}`);
  console.log(`  bun --compile --target=${t.bunTarget}`);
  await $`bun build --compile --target=${t.bunTarget} src/index.ts --outfile ${hshOut}`.quiet();

  // 2. Download daemon + scripts (from cache after the first target).
  const assets = await downloadTargetAssets(rel, { goos: t.goos, goarch: t.goarch });

  // 3. Stage daemon. We don't symlink because the archive needs a
  // real file; copyFile is cheap.
  const daemonOut = join(stagingDir, `hsh-tunneld${t.exe ? ".exe" : ""}`);
  await copyFile(assets.daemon, daemonOut);

  // Unix-only: copy install scripts. We deliberately do not ship
  // them in the Windows archive because (a) they're sh scripts and
  // (b) the Windows install path (RD-217 follow-up) needs its own
  // PowerShell wrapper anyway.
  if (!t.exe) {
    await copyFile(assets.installScript, join(stagingDir, "install.sh"));
    await copyFile(assets.uninstallScript, join(stagingDir, "uninstall.sh"));
  }

  // 4. Top-level README inside the archive. Keep it short — the
  // canonical docs live at hoop.dev/docs/tunnel and we don't want
  // to maintain three forks.
  await writeFile(
    join(stagingDir, "README.md"),
    archiveReadme(t, rel.version),
  );

  // 5. Archive.
  const archivePath = join(DIST, t.archive);
  if (t.archive.endsWith(".zip")) {
    await makeZip(stagingDir, resolve(archivePath));
  } else {
    await makeTarGz(stagingDir, archivePath);
  }
  const sizeMB = (await fileSize(archivePath)) / (1024 * 1024);
  console.log(`  ✓ ${archivePath} (${sizeMB.toFixed(1)} MB)`);
}

/**
 * archiveReadme returns the README.md body bundled at the top of
 * each archive. Per-target so the install instructions are accurate
 * for the platform the user just unpacked.
 */
function archiveReadme(t: BuildTarget, daemonVersion: string): string {
  const unixInstall = `
## Install

\`\`\`
./install.sh
\`\`\`

The script self-elevates with sudo and registers hsh-tunneld with
your system service manager. Currently supports **systemd on Linux
only**; LaunchDaemon on macOS is tracked as an RD-217 follow-up.

After installation, add yourself to the \`hsh\` group:

\`\`\`
sudo usermod -aG hsh $USER
\`\`\`

Log out and back in for the group change to take effect, then:

\`\`\`
hsh tunnel login
hsh tunnel connections
\`\`\`

## Uninstall

\`\`\`
./uninstall.sh           # remove the service, keep config
./uninstall.sh --purge   # remove everything
\`\`\`
`;

  const windowsInstall = `
## Install (Windows)

\`hsh-tunneld\` Windows service support is not yet shipped; this
archive includes the binaries but no install script. Use the
unprivileged \`hsh\` for everything that doesn't need the tunnel,
and watch the [release notes](https://github.com/hoophq/hsh/releases)
for Windows-service support.
`;

  return `# hsh ${t.goos}/${t.goarch}

This archive contains:

- \`hsh\` — unprivileged CLI you'll use day-to-day.
- \`hsh-tunneld\` — privileged daemon (version ${daemonVersion}) that
  manages the network tunnel.
${t.exe ? "" : "- `install.sh`, `uninstall.sh` — system-service wrappers.\n"}- \`README.md\` — this file.

${t.exe ? windowsInstall : unixInstall}

Full documentation: https://hoop.dev/docs/tunnel
`;
}

/**
 * Replace src/daemon-version-stamp.ts with a generated version that
 * pins BUNDLED_DAEMON_VERSION to the resolved concrete tag, run the
 * caller's build work, then restore the source file.
 *
 * The substitute file's TypeScript shape is identical to the source
 * version (single named export, same type, same comments at the top)
 * so any consumer importing BUNDLED_DAEMON_VERSION gets a constant
 * string at compile time — Bun --compile inlines it into the produced
 * binary.
 *
 * Why we don't just edit + commit: the source file represents the
 * symbolic pin, not the resolved one. Committing the resolved
 * version to git would couple every commit to a successful daemon
 * download at commit time, which is fragile. The stamp is a build
 * artifact, fully derivable from `HSH_TUNNELD_VERSION` + the API
 * resolution, and should never be in the source tree at rest.
 */
async function withStamp<T>(resolvedVersion: string, fn: () => Promise<T>): Promise<T> {
  const stampPath = "src/daemon-version-stamp.ts";
  const original = await readFile(stampPath, "utf8");
  // Generated stamp body. We embed the version as a string literal
  // so Bun --compile can dead-code-eliminate the unused import path
  // (daemon-version.ts's HSH_TUNNELD_VERSION is no longer referenced).
  const generated = `// AUTO-GENERATED at build time by scripts/build.ts.
// This file is restored to its source-tree content after the build
// completes; if you see this comment in a committed file, the build
// died mid-flight — run \`git restore src/daemon-version-stamp.ts\`.

/**
 * The resolved daemon version bundled with this hsh build. The build
 * script wrote this at build time after resolving the HSH_TUNNELD_VERSION
 * pin against the hoophq/hoop GitHub Release.
 */
export const BUNDLED_DAEMON_VERSION: string = ${JSON.stringify(resolvedVersion)};
`;
  await writeFile(stampPath, generated);
  try {
    return await fn();
  } finally {
    // Always restore, even on failure, so the working tree stays
    // identical to HEAD after a build run.
    await writeFile(stampPath, original);
  }
}
