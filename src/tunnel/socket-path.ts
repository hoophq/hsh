/**
 * Resolution of the hsh-tunneld control-plane socket and token paths.
 *
 * The daemon writes both files itself on startup (see
 * tunnel/ipc/socket_unix.go and tunnel/ipc/auth.go in hoophq/hoop). On
 * the client side we just need to know *where* to look. The rules are:
 *
 *   1. Env-var override wins (HSH_TUNNELD_SOCKET, HSH_TUNNELD_TOKEN_FILE).
 *      Used in dev where the daemon is launched outside /var/run.
 *   2. Otherwise: the platform-default path the installer creates.
 *   3. If neither exists yet, callers receive `undefined` and surface
 *      "daemon not running / not installed" to the user.
 */

import { existsSync, readFileSync } from "fs";
import { platform } from "os";
import { dirname, join } from "path";

/**
 * Default socket path on each platform. These match the constants
 * exported from tunnel/ipc/socket.go in hoophq/hoop.
 *
 * On Unix the socket and the control-token live inside the same
 * /var/run/hsh/ directory; that directory is created by systemd's
 * `RuntimeDirectory=hsh` clause (or by the macOS LaunchDaemon
 * installer) so the OS owns its lifecycle and we don't have to
 * recreate it after a reboot.
 */
export const DEFAULT_SOCKET_PATH = {
  unix: "/var/run/hsh/hsh.sock",
  win32: "\\\\.\\pipe\\hsh",
} as const;

/**
 * Default token-file path. Lives in the same runtime directory as the
 * socket so a single chown of /var/run/hsh/ grants the `hsh` group
 * access to both. On macOS/Linux the daemon writes mode 0640, so the
 * caller's effective uid/gid must include the `hsh` group to read it.
 */
export const DEFAULT_TOKEN_PATH = {
  unix: "/var/run/hsh/control-token",
  // Windows uses %PROGRAMDATA% (a system-wide writable location). The
  // exact env-var expansion happens lazily because process.env on Windows
  // can have casing quirks.
  win32_subpath: "hsh\\control-token",
} as const;

/**
 * Result of resolveSocketPath / resolveTokenPath. Telling apart "user
 * explicitly told us where to look" from "we guessed" lets the error
 * messages be more helpful: an env-var override that points at a
 * missing file is a config bug; a default that doesn't exist usually
 * means the daemon isn't installed yet.
 */
export interface ResolvedPath {
  /** Absolute path we'll read/connect to. */
  path: string;
  /** True when an HSH_TUNNELD_* env override was used. */
  fromEnv: boolean;
  /** True when the file exists on disk right now. */
  exists: boolean;
}

/**
 * Resolve the socket path the daemon is (supposed to be) listening on.
 *
 * Never throws — a missing socket is a normal "daemon down" state the
 * caller surfaces, not an error. Callers should branch on `exists`.
 */
export function resolveSocketPath(): ResolvedPath {
  const override = process.env.HSH_TUNNELD_SOCKET?.trim();
  if (override) {
    return { path: override, fromEnv: true, exists: existsSync(override) };
  }
  const fallback = defaultSocketPath();
  return { path: fallback, fromEnv: false, exists: existsSync(fallback) };
}

/**
 * Resolve the control-token file path. Same semantics as
 * resolveSocketPath: a missing file is "daemon down" / "not installed".
 *
 * Honors HSH_TUNNELD_TOKEN_FILE; otherwise defaults to the
 * platform-installer location, OR (when an HSH_TUNNELD_SOCKET override
 * is in effect) defaults to "<dir-of-socket>/hsh/control-token" — that
 * matches what hsh-tunneld writes when launched with a custom socket
 * path and no explicit --ipc-token-file (see startIPCServer in
 * cmd/hsh-tunneld/main.go).
 */
export function resolveTokenPath(): ResolvedPath {
  const override = process.env.HSH_TUNNELD_TOKEN_FILE?.trim();
  if (override) {
    return { path: override, fromEnv: true, exists: existsSync(override) };
  }
  const sock = resolveSocketPath();
  if (sock.fromEnv) {
    // Dev path: daemon was launched with --ipc-socket=/tmp/foo/hsh.sock,
    // which defaults the token to /tmp/foo/hsh/control-token. Mirror
    // the same convention so `hsh tunnel` finds it without extra
    // config. We propagate fromEnv=true here because the *socket* came
    // from an env override; the token path is derived but the
    // intentional choice belongs to the user.
    const derived = join(dirname(sock.path), "hsh", "control-token");
    return { path: derived, fromEnv: true, exists: existsSync(derived) };
  }
  const fallback = defaultTokenPath();
  return { path: fallback, fromEnv: false, exists: existsSync(fallback) };
}

/**
 * Read the current control token. Returns undefined if the file is
 * missing or unreadable (e.g. permission denied because the user is
 * not yet in group `hsh`); callers should treat that as "talk to the
 * user" rather than an exception.
 */
export function readControlToken(): string | undefined {
  const t = resolveTokenPath();
  if (!t.exists && !existsSync(t.path)) return undefined;
  try {
    return readFileSync(t.path, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function defaultSocketPath(): string {
  return platform() === "win32" ? DEFAULT_SOCKET_PATH.win32 : DEFAULT_SOCKET_PATH.unix;
}

function defaultTokenPath(): string {
  if (platform() === "win32") {
    const programData = process.env.PROGRAMDATA ?? process.env.ProgramData ?? "C:\\ProgramData";
    return join(programData, DEFAULT_TOKEN_PATH.win32_subpath);
  }
  return DEFAULT_TOKEN_PATH.unix;
}
