import { spawnSync } from "child_process";
import type { KeychainBackend } from "./interface.ts";

const DEFAULT_SERVICE = "hsh";
const DEFAULT_ACCOUNT = "token";

/**
 * Bounded timeout for all keychain CLI calls (ms).
 * A wedged Keychain daemon must not block the user's shell indefinitely.
 */
const TIMEOUT_MS = 5000;

/**
 * Quote a value for a `security -i` command line.
 *
 * Inside double quotes security's tokenizer honours backslash escapes:
 * `\\` → `\` and `\"` → `"` (verified empirically against the security
 * CLI on macOS 15).  The interactive protocol is line-oriented, so
 * values containing control characters cannot be represented — callers
 * must reject them first (see assertRepresentable).
 */
function quoteForSecurityI(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * The `security -i` protocol is line-oriented: a token containing a
 * newline (or any other control character) cannot be transported.  Real
 * tokens are JWTs (base64url + dots) so this never fires in practice —
 * it exists to turn a silent protocol corruption into a loud error.
 */
function assertRepresentable(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("macOS Keychain: token contains control characters and cannot be stored");
  }
}

/**
 * macOS Keychain backend — delegates to the `security` CLI that ships with
 * every macOS installation (no Homebrew dependency, no native module).
 *
 * Keychain item attributes:
 *   service  = "hsh"
 *   account  = "token"
 *   kind     = "application password"
 *
 * The token value is passed to `security` in **interactive mode**
 * (`security -i`) with the full command written to stdin.  This keeps the
 * secret off the process argv, where it would otherwise be readable by any
 * same-user process via `ps` for the lifetime of the (brief) security
 * invocation.  Reads still use plain argv (`find-generic-password -w`)
 * because no secret material appears on the command line for reads.
 *
 * `security -i` exits with the status of the executed command (verified:
 * 0 on success, 44 on item-not-found), so error handling is identical to
 * direct invocation.
 */
export class MacOSKeychain implements KeychainBackend {
  readonly name = "macOS Keychain";

  /**
   * Service/account are injectable for integration tests so they can
   * operate on a scratch keychain item instead of the real hsh token.
   * Production code always uses the defaults.
   */
  constructor(
    private readonly service: string = DEFAULT_SERVICE,
    private readonly account: string = DEFAULT_ACCOUNT,
  ) {}

  async set(value: string): Promise<void> {
    assertRepresentable(value);

    // -U updates an existing item in place — no destructive
    // delete-then-add, so a failure leaves the previous token intact.
    const command = [
      "add-generic-password",
      "-s", quoteForSecurityI(this.service),
      "-a", quoteForSecurityI(this.account),
      "-U",
      "-w", quoteForSecurityI(value),
    ].join(" ") + "\n";

    const result = spawnSync("security", ["-i"], {
      input: command,
      stdio: ["pipe", "pipe", "pipe"],
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
      "-s", this.service,
      "-a", this.account,
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
      "-s", this.service,
      "-a", this.account,
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
