/**
 * Keychain backend interface.
 *
 * Each backend stores a single string value (the JWT access token) under
 * a fixed service + account key.  The interface is intentionally minimal
 * and synchronous-feeling at the call site — all I/O is async but callers
 * `await` them directly.
 *
 * Implementations:
 *   - MacOSKeychain   — macOS Keychain via `security` CLI (no native deps)
 *   - LinuxKeychain   — libsecret via `secret-tool` CLI
 *   - FileKeychain    — plaintext 0600 JSON file (fallback / CI / headless)
 *
 * Use `getKeychain()` from `./auto.ts` instead of constructing backends
 * directly — it handles platform detection and availability checks.
 */
export interface KeychainBackend {
  /** Human-readable name shown in debug/warning messages. */
  readonly name: string;

  /**
   * Store `value` under the hsh token slot.
   * Overwrites any existing value.
   */
  set(value: string): Promise<void>;

  /**
   * Retrieve the stored token, or `null` if absent / inaccessible.
   * Never throws — backend errors are treated as "no token".
   */
  get(): Promise<string | null>;

  /**
   * Remove the stored token.  No-op if it does not exist.
   * Never throws.
   */
  delete(): Promise<void>;
}
