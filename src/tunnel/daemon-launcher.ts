/**
 * Resolve and (optionally) spawn the bundled hsh-tunneld daemon.
 *
 * For v1 we deliberately do NOT manage the daemon as a system service
 * from this code (that's RD-217's job — the platform installer
 * registers a LaunchDaemon / systemd unit / Windows Service). What
 * `hsh tunnel start` does today is a developer convenience: it spawns
 * the bundled binary in the foreground so the user can see logs and
 * Ctrl-C it. This lets us validate the end-to-end UX before the
 * installer ships.
 *
 * Resolution order for the daemon binary path:
 *
 *   1. HSH_TUNNELD_PATH env override — used during local dev when the
 *      hsh CLI is run from `bun run dev` and the daemon binary lives
 *      somewhere outside the bundle (e.g. ../hoop/dist/release-binaries/).
 *   2. <dir-of-hsh-executable>/hsh-tunneld[.exe] — production layout,
 *      same directory the brew/tarball install puts both binaries.
 *   3. The first hsh-tunneld[.exe] on $PATH.
 *
 * If none of the above resolve to an existing file we report
 * "not installed" with the searched paths so the operator can see what
 * we tried.
 */

import { spawnSync, type SpawnOptions } from "child_process";
import { execFileSync, spawn } from "child_process";
import { dirname, join, resolve as pathResolve } from "path";
import { existsSync } from "fs";
import { platform } from "os";
import { debug } from "../ui/log.ts";

/**
 * Result of resolveDaemonBinary. We surface `searched` so the error
 * message can be specific ("looked in X and Y, no match") rather than
 * just "not found".
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
 * Never throws; missing binary is a UX state the caller renders, not
 * an exception.
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
    // Explicit override that points at nothing is an actionable bug —
    // we report it but keep falling through so the dev case (forgot to
    // build the daemon) still gets a useful "looked here too" hint.
  }

  // Sibling-of-hsh path: this is what the brew formula and the tarball
  // installer produce. `process.execPath` points at the bun runtime
  // when run via `bun run dev`, so we use `process.argv[1]` (the
  // script entrypoint) instead, which resolves to the compiled hsh
  // binary in a packaged install and to src/index.ts in dev.
  const argv1 = process.argv[1];
  if (argv1) {
    const sibling = join(dirname(argv1), exeName);
    searched.push(sibling);
    if (existsSync(sibling)) {
      return { path: pathResolve(sibling), searched, fromEnv: false };
    }
  }

  // Last resort: PATH lookup. `which`/`where` is the cheapest path; we
  // shell out because Node's path lookup logic is non-trivial on
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
 * Options for spawning the daemon. Most callers only set `socketPath`
 * (in dev) and `token` (the gateway access token).
 */
export interface SpawnDaemonOptions {
  /** Absolute path to the binary. Caller resolves it with resolveDaemonBinary first. */
  binaryPath: string;
  /** Where the daemon should bind its control-plane socket. */
  socketPath: string;
  /** Where the daemon should write its rotating control token. */
  tokenPath: string;
  /** HOOP_APIURL the daemon connects to. Passed through env. */
  apiUrl: string;
  /** HOOP_TOKEN the daemon should use. */
  token: string;
  /** Optional HOOP_GRPCURL override (auto-discovered if absent). */
  grpcUrl?: string;
  /** Session seed override (controls the /48 prefix). Defaults to a stable per-host value. */
  sessionSeed?: string;
  /** If true, spawn under `sudo -E` (needed for CAP_NET_ADMIN). Defaults to true on Linux/macOS. */
  useSudo?: boolean;
  /** Inherit stdio so the operator sees daemon logs. Defaults to true. */
  inheritStdio?: boolean;
}

/**
 * Spawn hsh-tunneld in the foreground. Returns the spawned process so
 * callers can wait on it / send signals.
 *
 * This is a thin wrapper around child_process.spawn — the real work
 * is composing the env, the args, and (on POSIX) the sudo prefix.
 */
export function spawnDaemon(opts: SpawnDaemonOptions): ReturnType<typeof spawn> {
  const useSudo = opts.useSudo ?? (platform() !== "win32");
  const args = [
    `--ipc-socket=${opts.socketPath}`,
    `--ipc-token-file=${opts.tokenPath}`,
  ];
  if (opts.sessionSeed) args.push(`--session=${opts.sessionSeed}`);

  // Daemon-side env vars (the daemon reads these directly today; RD-216
  // will replace them with the daemon-managed config file).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOOP_APIURL: opts.apiUrl,
    HOOP_TOKEN: opts.token,
    ...(opts.grpcUrl ? { HOOP_GRPCURL: opts.grpcUrl } : {}),
  };

  let command: string;
  let commandArgs: string[];
  if (useSudo) {
    command = "sudo";
    // `-E` preserves the env we built above (HOOP_*); without it sudo
    // strips them and the daemon would fall back to its own (empty)
    // env and fail with "HOOP_APIURL is required".
    commandArgs = ["-E", opts.binaryPath, ...args];
  } else {
    command = opts.binaryPath;
    commandArgs = args;
  }

  debug("tunnel.spawn", "starting daemon", { command, args: commandArgs });

  const spawnOpts: SpawnOptions = {
    env,
    stdio: opts.inheritStdio === false ? "ignore" : "inherit",
    detached: false,
  };
  return spawn(command, commandArgs, spawnOpts);
}

/**
 * Hint string for messages: how the operator launched bun matters
 * less than the absolute path of the binary we'll spawn, so just show
 * that. Returns "<not found>" if the binary couldn't be resolved.
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
 * Uses `command -v` on POSIX (POSIX-portable) and `where` on Windows.
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

/**
 * Best-effort check that the operator has whatever password / privilege
 * helper they'll need. On Linux/macOS we verify `sudo` is present;
 * without it `hsh tunnel start` would just dump "command not found".
 * Windows always needs Run-as-Administrator which we can't trigger
 * non-interactively, so we just return true and let the daemon fail
 * with its own permission error.
 */
export function checkPrivilegeHelper(): { ok: boolean; reason?: string } {
  if (platform() === "win32") return { ok: true };
  const r = spawnSync("sudo", ["-V"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: "`sudo` is not available; install it or run hsh-tunneld manually" };
  }
  return { ok: true };
}
