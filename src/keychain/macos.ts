import { spawnSync } from "child_process";
import type { KeychainBackend } from "./interface.ts";

const SERVICE = "hsh";
const ACCOUNT = "token";

/**
 * macOS Keychain backend — delegates to the `security` CLI that ships with
 * every macOS installation (no Homebrew dependency, no native module).
 *
 * Keychain item attributes:
 *   service  = "hsh"
 *   account  = "token"
 *   kind     = "application password"
 *
 * The security CLI is synchronous by nature; we wrap the calls in
 * spawnSync so callers can `await` the backend uniformly without
 * actually needing an event loop turn.
 */
export class MacOSKeychain implements KeychainBackend {
  readonly name = "macOS Keychain";

  async set(value: string): Promise<void> {
    // Delete first to avoid "already exists" errors, then add.
    // `security delete-generic-password` exits non-zero if absent; that's fine.
    spawnSync("security", [
      "delete-generic-password",
      "-s", SERVICE,
      "-a", ACCOUNT,
    ], { stdio: "pipe" });

    const result = spawnSync("security", [
      "add-generic-password",
      "-s", SERVICE,
      "-a", ACCOUNT,
      "-w", value,
      "-U", // update if exists (belt-and-suspenders)
    ], { stdio: "pipe" });

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
      "-w", // print password only
    ], { stdio: "pipe" });

    if (result.status !== 0) {
      // Exit 44 = item not found — that's a normal "not logged in" state.
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
    ], { stdio: "pipe" });
    // Ignore exit code — non-zero just means it wasn't there.
  }

  /**
   * Check whether the `security` CLI is available (it always is on macOS,
   * but this guard makes the auto-detector safe to call on Linux in tests).
   */
  static isAvailable(): boolean {
    const result = spawnSync("security", ["--version"], { stdio: "pipe" });
    return result.status === 0 && result.error == null;
  }
}
