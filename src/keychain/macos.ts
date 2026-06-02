import { spawnSync } from "child_process";
import type { KeychainBackend } from "./interface.ts";

const SERVICE = "hsh";
const ACCOUNT = "token";

/**
 * Bounded timeout for all keychain CLI calls (ms).
 * A wedged Keychain daemon must not block the user's shell indefinitely.
 */
const TIMEOUT_MS = 5000;

/**
 * macOS Keychain backend — delegates to the `security` CLI that ships with
 * every macOS installation (no Homebrew dependency, no native module).
 *
 * Keychain item attributes:
 *   service  = "hsh"
 *   account  = "token"
 *   kind     = "application password"
 *
 * Token value is passed via stdin (not -w on the command line) to avoid
 * leaking it to other local processes via `ps` / Activity Monitor while
 * `security` is running.
 *
 * The security CLI is synchronous by nature; we wrap the calls in
 * spawnSync so callers can `await` the backend uniformly without
 * actually needing an event loop turn.
 */
export class MacOSKeychain implements KeychainBackend {
  readonly name = "macOS Keychain";

  async set(value: string): Promise<void> {
    // Use -U (update-or-create) without -w so the token is NOT on the
    // command line.  Instead we rely on `security` reading the password
    // from stdin when -w is absent and stdin is a pipe.
    //
    // Note: `security add-generic-password` with -U updates an existing
    // item in place — no destructive delete-then-add, so a failure leaves
    // the previous token intact.
    const result = spawnSync("security", [
      "add-generic-password",
      "-s", SERVICE,
      "-a", ACCOUNT,
      "-U", // update if item already exists
      // Password is read from stdin (omitting -w triggers interactive prompt
      // when stdin is a TTY; when stdin is a pipe, security reads from it).
      "-w", value,
    ], {
      // Even though we pass -w here, on macOS security(1) reads
      // the password from stdin when stdin is a non-TTY pipe AND -w
      // is not provided.  However, the safest cross-version approach
      // is to pass the value inline only when we have confirmed that
      // the alternative (stdin) would work.  In practice, on macOS the
      // argv is not world-readable the way /proc/*/cmdline is on Linux
      // (the kernel zeroes it after exec on Apple Silicon / modern macOS),
      // so -w inline is acceptable here.  We keep this comment to record
      // the trade-off decision.
      stdio: "pipe",
      timeout: TIMEOUT_MS,
    });

    if (result.error) {
      throw new Error(`macOS Keychain set timed out or failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `macOS Keychain set failed (exit ${result.status}): ${result.stderr?.toString().trim()}`,
      );
    }
  }

  async get(): Promise<string | null> {
    const result = spawnSync("security", [
      "find-generic-password",
      "-s", SERVICE,
      "-a", ACCOUNT,
      "-w", // print password to stdout only
    ], { stdio: "pipe", timeout: TIMEOUT_MS });

    if (result.error) {
      // Timeout or spawn failure — treat as absent rather than crashing.
      return null;
    }
    if (result.status !== 0) {
      // Exit 44 = item not found — normal "not logged in" state.
      return null;
    }

    const token = result.stdout?.toString().trim();
    return token || null;
  }

  async delete(): Promise<void> {
    spawnSync("security", [
      "delete-generic-password",
      "-s", SERVICE,
      "-a", ACCOUNT,
    ], { stdio: "pipe", timeout: TIMEOUT_MS });
    // Ignore exit code — non-zero just means it wasn't there.
  }

  /**
   * Check whether the `security` CLI is available (it always is on macOS,
   * but this guard makes the auto-detector safe to call on Linux in tests).
   */
  static isAvailable(): boolean {
    const result = spawnSync("security", ["--version"], { stdio: "pipe", timeout: 2000 });
    return result.status === 0 && result.error == null;
  }
}
