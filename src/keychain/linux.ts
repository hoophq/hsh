import { spawnSync } from "child_process";
import type { KeychainBackend } from "./interface.ts";

const LABEL = "hsh token";
const ATTR_KEY = "application";
const ATTR_VAL = "hsh";

/**
 * Bounded timeout for all secret-tool CLI calls (ms).
 * A wedged Secret Service daemon must not block the user's shell indefinitely.
 */
const TIMEOUT_MS = 5000;

/**
 * Linux libsecret backend — delegates to the `secret-tool` CLI provided
 * by the `libsecret-tools` package (Debian/Ubuntu) or `libsecret` (Arch,
 * Fedora).  Requires a running Secret Service daemon (gnome-keyring or
 * KWallet with the compatibility bridge).
 *
 * Items are stored with a single lookup attribute:
 *   application = "hsh"
 *
 * `secret-tool` reads the secret from stdin on `store` and prints it to
 * stdout on `lookup` — no shell quoting issues with the token value.
 *
 * If `secret-tool` is not installed or no daemon is running, the
 * availability check returns false and the auto-detector falls back to
 * the file backend.
 */
export class LinuxKeychain implements KeychainBackend {
  readonly name = "libsecret (secret-tool)";

  async set(value: string): Promise<void> {
    // secret-tool store reads the secret from stdin — never on the command line.
    const result = spawnSync("secret-tool", [
      "store",
      "--label", LABEL,
      ATTR_KEY, ATTR_VAL,
    ], {
      input: value,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });

    if (result.error) {
      throw new Error(`libsecret set timed out or failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `libsecret set failed (exit ${result.status}): ${result.stderr?.toString().trim()}`,
      );
    }
  }

  async get(): Promise<string | null> {
    const result = spawnSync("secret-tool", [
      "lookup",
      ATTR_KEY, ATTR_VAL,
    ], { stdio: "pipe", timeout: TIMEOUT_MS });

    if (result.error) {
      // Timeout or spawn failure — treat as absent rather than crashing.
      return null;
    }
    if (result.status !== 0) {
      // Non-zero means item not found or daemon unavailable — treat as absent.
      return null;
    }

    const token = result.stdout?.toString().trim();
    return token || null;
  }

  async delete(): Promise<void> {
    spawnSync("secret-tool", [
      "clear",
      ATTR_KEY, ATTR_VAL,
    ], { stdio: "pipe", timeout: TIMEOUT_MS });
    // Ignore exit code — non-zero just means it wasn't there.
  }

  /**
   * Check whether `secret-tool` is installed AND a Secret Service daemon is
   * reachable.  We do this by attempting a `lookup` for a non-existent key:
   * if the daemon is absent the command exits with a D-Bus error (non-zero);
   * if it's present it exits 0 (no item found) or 1 (no such item) but NOT
   * with a D-Bus connection error.
   *
   * We also check that the binary exists first to avoid a slow timeout when
   * the PATH lookup itself fails.
   */
  static isAvailable(): boolean {
    // Fast check: is the binary on PATH?
    const which = spawnSync("which", ["secret-tool"], { stdio: "pipe" });
    if (which.status !== 0) return false;

    // Probe the daemon: try to look up a deliberately missing item.
    // Exit 0 = "no such item" (daemon up), non-zero with D-Bus error = daemon down.
    const probe = spawnSync("secret-tool", ["lookup", "__hsh_probe__", "__absent__"], {
      stdio: "pipe",
      timeout: 2000,
    });

    if (probe.error) return false; // spawn failed (binary gone, timeout, etc.)

    // If stderr contains "No such interface" or "Failed to connect" the
    // daemon isn't running.
    const stderr = probe.stderr?.toString() ?? "";
    if (
      stderr.includes("Failed to connect") ||
      stderr.includes("No such interface") ||
      stderr.includes("Could not connect")
    ) {
      return false;
    }

    return true;
  }
}
