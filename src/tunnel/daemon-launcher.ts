/**
 * Resolve the bundled hsh-tunneld daemon binary's location on disk.
 *
 * We deliberately do NOT manage the daemon as a child process from
 * this code: the platform installer (RD-217) registers it as a
 * systemd unit / LaunchDaemon / Windows Service, and lifecycle
 * (start / stop / restart) is the OS service manager's job. The hsh
 * CLI talks to the running daemon via IPC and otherwise gets out of
 * the way.
 *
 * This module exists so commands like `hsh tunnel daemon-path` can
 * answer "where IS the daemon binary on disk" — useful for
 * troubleshooting whether the install actually copied it, whether
 * the right tarball was extracted, etc. Previously this file also
 * exported spawnDaemon + checkPrivilegeHelper to drive a foreground
 * `hsh tunnel start`, but that command was removed when RD-217 made
 * the system-service install the canonical lifecycle path.
 *
 * Resolution order for the daemon binary path:
 *
 *   1. HSH_TUNNELD_PATH env override — used during local dev when
 *      the hsh CLI is run from `bun run dev` and the daemon binary
 *      lives somewhere outside the bundle
 *      (e.g. ../hoop/dist/release-binaries/).
 *   2. <dir-of-hsh-executable>/hsh-tunneld[.exe] — production layout,
 *      same directory the brew/tarball install puts both binaries.
 *   3. The first hsh-tunneld[.exe] on $PATH.
 *
 * If none of the above resolve to an existing file we return path
 * undefined with the searched paths so the operator can see what we
 * tried.
 */

import { execFileSync } from "child_process";
import { dirname, join, resolve as pathResolve } from "path";
import { existsSync } from "fs";
import { platform } from "os";

/**
 * Result of resolveDaemonBinary. We surface `searched` so the error
 * message can be specific ("looked in X and Y, no match") rather
 * than just "not found".
 */
export interface DaemonBinary {
  path?: string;
  /** Paths checked, in order, regardless of whether they matched. */
  searched: string[];
  fromEnv: boolean;
}

/**
 * Find the hsh-tunneld binary the operator should run.
 *
 * Never throws; missing binary is a UX state the caller renders,
 * not an exception.
 */
export function resolveDaemonBinary(): DaemonBinary {
  const exeName = daemonExeName();
  const searched: string[] = [];

  const override = process.env.HSH_TUNNELD_PATH?.trim();
  if (override) {
    searched.push(override);
    if (existsSync(override)) {
      return { path: pathResolve(override), searched, fromEnv: true };
    }
    // Explicit override that points at nothing is an actionable bug
    // — we report it but keep falling through so the dev case
    // (forgot to build the daemon) still gets a useful "looked
    // here too" hint.
  }

  // Sibling-of-hsh path: this is what the brew formula and the
  // tarball installer produce. `process.execPath` points at the bun
  // runtime when run via `bun run dev`, so we use `process.argv[1]`
  // (the script entrypoint) instead, which resolves to the compiled
  // hsh binary in a packaged install and to src/index.ts in dev.
  const argv1 = process.argv[1];
  if (argv1) {
    const sibling = join(dirname(argv1), exeName);
    searched.push(sibling);
    if (existsSync(sibling)) {
      return { path: pathResolve(sibling), searched, fromEnv: false };
    }
  }

  // Last resort: PATH lookup. `which`/`where` is the cheapest path;
  // we shell out because Node's path lookup logic is non-trivial on
  // Windows (PATHEXT) and we don't want a custom reimplementation.
  const lookup = whichBinary(exeName);
  if (lookup) {
    searched.push(lookup);
    return { path: lookup, searched, fromEnv: false };
  }
  // No-op push so the operator sees we tried PATH too.
  searched.push(`<PATH lookup for ${exeName}>`);
  return { path: undefined, searched, fromEnv: !!override };
}

/**
 * Hint string for messages: how the operator launched bun matters
 * less than the absolute path of the binary we'll spawn, so just
 * show that. Returns "<not found>" if the binary couldn't be
 * resolved.
 */
export function describeDaemonBinary(b: DaemonBinary): string {
  if (b.path) return b.path;
  return `<not found; searched: ${b.searched.join(", ")}>`;
}

function daemonExeName(): string {
  return platform() === "win32" ? "hsh-tunneld.exe" : "hsh-tunneld";
}

/**
 * Cross-platform `which`. Returns the resolved path or undefined.
 * Uses `command -v` on POSIX (POSIX-portable) and `where` on
 * Windows.
 */
function whichBinary(name: string): string | undefined {
  try {
    if (platform() === "win32") {
      const out = execFileSync("where", [name], { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      // `where` may return multiple lines; first match wins.
      const first = out.split(/\r?\n/)[0]?.trim();
      return first || undefined;
    }
    const out = execFileSync("command", ["-v", name], {
      shell: "/bin/sh",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
