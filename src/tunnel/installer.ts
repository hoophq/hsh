/**
 * Runtime acquisition + privileged installation of the `hsh-tunneld`
 * daemon (DEP-141).
 *
 * # Why this exists
 *
 * Until now the daemon only reached a user's machine through the
 * release tarball: extract, then run `./install.sh` (Linux) or
 * `sudo ./hsh-tunneld install` (macOS) by hand. Anyone who installed
 * `hsh` any other way (brew, nix, a bare binary copied onto PATH) got
 * a CLI that silently skipped every tunnel feature, because
 * `loginDaemon()` treats an absent daemon as "not installed, say
 * nothing". This module closes that gap: `hsh` fetches the daemon for
 * the running OS/arch itself and hands it to the OS service manager.
 *
 * # Trust model
 *
 * The artifact we download is executed **as root**. Verification is
 * therefore mandatory, not best-effort:
 *
 *   1. The version is the one this build was stamped against
 *      (BUNDLED_DAEMON_VERSION), so `hsh` and `hsh-tunneld` stay a
 *      matched pair — the same guarantee the tarball gives.
 *   2. `SHA256SUMS` from that release is the trust root. A missing
 *      manifest, a missing entry, or a hash mismatch aborts the
 *      install. We never fall back to "install unverified".
 *
 * This mirrors the build-time policy in scripts/lib/daemon-download.ts;
 * the difference is only *when* the download happens (user's machine at
 * setup time vs. CI at release time).
 *
 * # Privilege escalation
 *
 * We do NOT re-implement service registration. `hsh-tunneld install`
 * already writes the systemd unit / LaunchDaemon plist, creates the
 * `hsh` group, adds the invoking user to it, and starts the service —
 * with test coverage on the Go side. We shell out to
 * `sudo <staged-binary> install` with inherited stdio so sudo itself
 * owns the password prompt (never hsh: we must never read, buffer, or
 * relay the user's password).
 *
 * `SUDO_USER` is what the daemon's installer reads to decide which
 * human to add to the `hsh` group, and sudo sets it for us.
 */

import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { ApiUnreachableError, fetchWithTimeout } from "../api/client.ts";
import { getHshDir } from "../config/store.ts";
import { BUNDLED_DAEMON_VERSION } from "../daemon-version-stamp.ts";
import { downloadAndInstall } from "../update/install.ts";
import { parseChecksumsFile } from "../update/releases.ts";
import { debug } from "../ui/log.ts";

/**
 * Release repo that publishes the daemon. Hard-coded for the same
 * reason scripts/lib/daemon-download.ts hard-codes it: a binary we run
 * as root needs an explicit, auditable trust root, not a configurable
 * one.
 */
const RELEASE_REPO = "hoophq/hoop";

/**
 * Download host. Release assets are served from github.com (the API
 * host only hands out metadata).
 *
 * `HSH_DAEMON_RELEASE_BASE` overrides it, mirroring the existing
 * `HSH_GITHUB_API` escape hatch in src/update/releases.ts. It exists so
 * tests can point the flow at a local stub and so a fork behind a
 * corporate mirror has one knob instead of a patch. It does not weaken
 * the trust model: the checksum manifest is fetched from the same base,
 * so anyone able to set this variable could already run arbitrary code
 * as the user.
 */
function downloadBase(): string {
  const override = process.env.HSH_DAEMON_RELEASE_BASE;
  if (override && override.trim() !== "") {
    return override.trim().replace(/\/+$/, "");
  }
  return "https://github.com";
}

/** Manifest that every daemon release attaches. */
const SHA256SUMS_NAME = "SHA256SUMS";

/** The manifest is ~1 KB; it should never need the download budget. */
const MANIFEST_TIMEOUT_MS = 15_000;

/**
 * Platforms the daemon publishes binaries for, keyed the way Go names
 * them — the release filename is `hsh-tunneld-<goos>-<goarch>[.exe]`.
 */
export interface DaemonTarget {
  goos: "linux" | "darwin" | "windows";
  goarch: "amd64" | "arm64";
}

/**
 * Map Bun's `process.platform`/`process.arch` onto the daemon's Go
 * naming. Returns null for a combination the daemon does not publish,
 * so the caller can print a precise "no daemon for your platform"
 * rather than 404-ing halfway through a download.
 *
 * Pure (takes its inputs) so tests can pin every combination without
 * touching process state.
 */
export function daemonTargetFor(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): DaemonTarget | null {
  const goarch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!goarch) return null;
  switch (platform) {
    case "linux":
      return { goos: "linux", goarch };
    case "darwin":
      return { goos: "darwin", goarch };
    case "win32":
      return { goos: "windows", goarch };
    default:
      return null;
  }
}

/**
 * Can this host actually complete `hsh setup`?
 *
 * False for architectures the daemon publishes no binary for, and for
 * Windows — hsh-tunneld's Windows service backend is still a stub that
 * returns ErrUnsupportedPlatform, so `install` would download 18 MB and
 * then refuse.
 *
 * Exported so callers that run setup *implicitly* (the daemon leg of
 * `hsh login`) can stay silent on hosts where it could only ever fail,
 * while an explicit `hsh setup` still gets the specific error from
 * `installDaemon` explaining why.
 */
export function daemonInstallSupported(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  const target = daemonTargetFor(platform, arch);
  return target !== null && target.goos !== "windows";
}

/** Release filename for a target. Mirrors `daemonAssetName` in scripts/lib. */
export function daemonAssetName(t: DaemonTarget): string {
  const suffix = t.goos === "windows" ? ".exe" : "";
  return `hsh-tunneld-${t.goos}-${t.goarch}${suffix}`;
}

/**
 * Where a downloaded daemon is staged before `hsh-tunneld install`
 * copies it to its final home (/usr/local/bin/hsh-tunneld).
 *
 * We stage inside the hsh state dir rather than a tmpdir so a failed
 * install leaves the (verified) binary somewhere the user can inspect
 * and re-run manually, and so HSH_HOME keeps tests hermetic.
 */
export function stagedDaemonPath(t: DaemonTarget): string {
  const dir = join(getHshDir(), "bin");
  mkdirSync(dir, { recursive: true });
  return join(dir, t.goos === "windows" ? "hsh-tunneld.exe" : "hsh-tunneld");
}

/**
 * Thrown for every failure mode of this module. `hint` carries the one
 * concrete next step the user can take, so callers render a consistent
 * two-line error instead of inventing their own remediation text.
 */
export class DaemonInstallError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "DaemonInstallError";
    this.hint = hint;
  }
}

/**
 * Fetch the SHA256 the release publishes for `assetName`.
 *
 * Absence is fatal, never a warning: this binary runs as root, so an
 * unverifiable download must not be installed. `hsh update` can afford
 * to warn-and-continue because it only replaces the unprivileged CLI
 * the user is already running.
 */
export async function fetchExpectedSha256(
  version: string,
  assetName: string,
): Promise<string> {
  const url = `${downloadBase()}/${RELEASE_REPO}/releases/download/${version}/${SHA256SUMS_NAME}`;
  debug("tunnel.install", `fetching manifest ${url}`);
  const res = await fetchWithTimeout(url, { timeoutMs: MANIFEST_TIMEOUT_MS });
  if (!res.ok) {
    throw new DaemonInstallError(
      `Could not fetch ${SHA256SUMS_NAME} for hsh-tunneld ${version} (HTTP ${res.status}).`,
      `Check ${url} is reachable, then retry.`,
    );
  }
  const sha = parseChecksumsFile(await res.text(), assetName);
  if (!sha) {
    throw new DaemonInstallError(
      `Release ${version} publishes no checksum for ${assetName}.`,
      "Refusing to install an unverified daemon. Report this against hoophq/hoop.",
    );
  }
  return sha;
}

/** Result of a completed download step. */
export interface DownloadedDaemon {
  path: string;
  version: string;
  assetName: string;
  bytes: number;
  sha256: string;
}

/**
 * Download the daemon for `target` at `version` and verify it against
 * the release manifest. Returns the staged path (mode 0755).
 *
 * Reuses `downloadAndInstall` from the self-update path: it already
 * streams to a sibling temp file, hashes while writing, discards on
 * mismatch, chmods 0755, and renames atomically. Duplicating that here
 * would be a second implementation of the same tricky sequence.
 */
export async function downloadDaemon(opts: {
  target: DaemonTarget;
  version: string;
}): Promise<DownloadedDaemon> {
  const { target, version } = opts;
  const assetName = daemonAssetName(target);
  const expectedSha256 = await fetchExpectedSha256(version, assetName);
  const dest = stagedDaemonPath(target);
  const url = `${downloadBase()}/${RELEASE_REPO}/releases/download/${version}/${assetName}`;

  // A stale staged binary from an earlier version would survive the
  // rename, but the temp file it renames over would not — clear it so
  // a failed verify can never leave last week's daemon in place.
  if (existsSync(dest)) {
    unlinkSync(dest);
  }

  debug("tunnel.install", `downloading ${url} -> ${dest}`);
  const result = await downloadAndInstall({ url, expectedSha256, binPath: dest });
  // downloadAndInstall skips chmod on Windows (it replaces a running
  // .exe there); on POSIX it already set 0755. Make the staged file
  // executable unconditionally so the spawn below cannot fail on mode.
  if (process.platform !== "win32") {
    chmodSync(dest, 0o755);
  }
  return {
    path: dest,
    version,
    assetName,
    bytes: result.bytesWritten,
    sha256: result.computedSha256,
  };
}

/**
 * Run `sudo <daemon> install`, letting sudo prompt for the password on
 * the inherited TTY.
 *
 * Design notes:
 *
 *   - stdio is inherited. hsh never sees the password; sudo reads it
 *     straight from the terminal. Any askpass/PAM behaviour the user
 *     configured (Touch ID, YubiKey) therefore keeps working.
 *   - Already root (CI images, `sudo hsh setup`) → exec the daemon
 *     directly. Wrapping root in sudo works but fails on hosts with no
 *     sudo installed, which is common in containers.
 *   - Extra args pass straight through so the daemon's flag parser
 *     stays the single source of truth for install options.
 */
export function runPrivilegedInstall(
  daemonPath: string,
  args: string[] = [],
): void {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const argv = [daemonPath, "install", ...args];
  const cmd = isRoot ? argv[0] : "sudo";
  const cmdArgs = isRoot ? argv.slice(1) : ["--", ...argv];

  debug("tunnel.install", `spawning ${cmd} ${cmdArgs.join(" ")}`);
  // `env` is passed explicitly rather than inherited by default: Bun
  // resolves the executable against the PATH snapshot taken at process
  // start, so a PATH edited after startup (test harnesses, a shell that
  // sourced a profile mid-session) would otherwise pick the wrong sudo.
  const res = spawnSync(cmd, cmdArgs, { stdio: "inherit", env: process.env });

  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (!isRoot && code === "ENOENT") {
      throw new DaemonInstallError(
        "sudo is not available on this host, and the daemon install needs root.",
        `Re-run as root: ${daemonPath} install`,
      );
    }
    throw new DaemonInstallError(
      `Could not run the daemon installer: ${res.error.message}`,
      `Try it manually: sudo ${daemonPath} install`,
    );
  }
  if (res.signal) {
    throw new DaemonInstallError(
      `The daemon installer was terminated by ${res.signal}.`,
      `Try it manually: sudo ${daemonPath} install`,
    );
  }
  if (res.status !== 0) {
    throw new DaemonInstallError(
      `The daemon installer exited with code ${res.status}.`,
      `Re-run it directly to see the full output: sudo ${daemonPath} install`,
    );
  }
}

/** What `installDaemon` did, for the caller's summary output. */
export interface DaemonInstallResult {
  version: string;
  assetName: string;
  stagedPath: string;
  bytes: number;
  sha256: string;
}

/**
 * Full flow: resolve target → download + verify → privileged install.
 *
 * `version` defaults to the daemon version this hsh build was stamped
 * with, keeping the CLI and daemon a matched pair. `onProgress` gets
 * human-readable milestones so the command layer owns all formatting
 * (this module prints nothing itself).
 */
export async function installDaemon(opts: {
  version?: string;
  installArgs?: string[];
  onProgress?: (message: string) => void;
} = {}): Promise<DaemonInstallResult> {
  const version = opts.version ?? BUNDLED_DAEMON_VERSION;
  const progress = opts.onProgress ?? (() => {});

  const target = daemonTargetFor(process.platform, process.arch);
  if (!target) {
    throw new DaemonInstallError(
      `No hsh-tunneld build exists for ${process.platform}/${process.arch}.`,
      "Supported: linux/x64, linux/arm64, darwin/x64, darwin/arm64, win32/x64, win32/arm64.",
    );
  }
  if (target.goos === "windows") {
    // The Go service package's Windows backend is still a stub that
    // returns ErrUnsupportedPlatform, so `hsh-tunneld install` would
    // download 18 MB and then refuse. Failing before the download is
    // the honest answer.
    throw new DaemonInstallError(
      "hsh-tunneld does not yet support installation as a Windows service.",
      "Use hsh without the tunnel for now; Windows service support is in progress.",
    );
  }

  progress(`Fetching hsh-tunneld ${version} for ${target.goos}/${target.goarch}`);
  let downloaded: DownloadedDaemon;
  try {
    downloaded = await downloadDaemon({ target, version });
  } catch (err) {
    if (err instanceof DaemonInstallError) throw err;
    if (err instanceof ApiUnreachableError) {
      throw new DaemonInstallError(
        `Could not download hsh-tunneld: ${err.reason}.`,
        "Check your network (or proxy) and retry.",
      );
    }
    throw new DaemonInstallError(
      `Could not download hsh-tunneld: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  progress(`Verified ${downloaded.assetName} (sha256 ${downloaded.sha256})`);
  progress("Registering the daemon with your system service manager (sudo required)");
  runPrivilegedInstall(downloaded.path, opts.installArgs);

  return {
    version,
    assetName: downloaded.assetName,
    stagedPath: downloaded.path,
    bytes: downloaded.bytes,
    sha256: downloaded.sha256,
  };
}
