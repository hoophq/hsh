import type { KeychainBackend } from "./interface.ts";
import { MacOSKeychain } from "./macos.ts";
import { LinuxKeychain } from "./linux.ts";
import { FileKeychain } from "./file.ts";

/**
 * Return the best available keychain backend for the current environment.
 *
 * Selection order:
 *
 *  1. HSH_KEYCHAIN_BACKEND env var — explicit override:
 *       "macos"     → MacOSKeychain (only valid on darwin)
 *       "libsecret" → LinuxKeychain (only valid on linux)
 *       "file"      → FileKeychain  (always available)
 *
 *  2. Platform auto-detection:
 *       darwin  → MacOSKeychain (security CLI always present on macOS)
 *       linux   → LinuxKeychain if secret-tool + daemon available,
 *                 otherwise FileKeychain
 *       other   → FileKeychain
 *
 * The result is cached after the first call so repeated accesses in the
 * same process don't re-probe the system.
 */

let _cached: KeychainBackend | null = null;

export function getKeychain(): KeychainBackend {
  if (_cached) return _cached;
  _cached = resolve();
  return _cached;
}

/**
 * Reset the cached backend — only intended for tests that need to swap
 * backends between cases.
 */
export function _resetKeychainCache(): void {
  _cached = null;
}

function resolve(): KeychainBackend {
  const override = process.env.HSH_KEYCHAIN_BACKEND?.toLowerCase().trim();

  if (override) {
    switch (override) {
      case "macos":
        return new MacOSKeychain();
      case "libsecret":
        return new LinuxKeychain();
      case "file":
        return new FileKeychain();
      default:
        // Unknown override value — warn and fall through to auto-detect.
        // We don't throw because a mis-typed env var shouldn't break login.
        console.error(
          `[hsh] Unknown HSH_KEYCHAIN_BACKEND="${override}". ` +
          `Valid values: macos, libsecret, file. Falling back to auto-detect.`,
        );
    }
  }

  const platform = process.platform;

  if (platform === "darwin") {
    // security(1) ships with every macOS — no availability check needed.
    return new MacOSKeychain();
  }

  if (platform === "linux") {
    if (LinuxKeychain.isAvailable()) {
      return new LinuxKeychain();
    }
    // Headless / CI / no daemon — fall through to file backend.
    return new FileKeychain();
  }

  // Windows or other — file backend.
  return new FileKeychain();
}
