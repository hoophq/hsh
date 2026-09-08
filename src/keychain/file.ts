import { join } from "path";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { getHshDir } from "../config/store.ts";
import { safeWrite } from "../util/safe-write.ts";
import type { KeychainBackend } from "./interface.ts";

/**
 * File-based fallback keychain backend.
 *
 * Stores the token as a raw string (no JSON wrapping) in
 * `~/.hsh/token` with mode 0600.  Atomic write via safeWrite.
 *
 * This is the backend used on:
 *   - headless Linux (no Secret Service daemon)
 *   - CI environments
 *   - any platform where the native keychain is unavailable or disabled
 *     via HSH_KEYCHAIN_BACKEND=file
 *
 * Note: the token is still plaintext on disk, same as the old auth.json.
 * The security improvement comes from using the OS keychain when available.
 * For headless environments, 0600 permissions remain the appropriate control.
 */
export class FileKeychain implements KeychainBackend {
  readonly name = "file (fallback)";

  private tokenPath(): string {
    return join(getHshDir(), "token");
  }

  async set(value: string): Promise<void> {
    safeWrite(this.tokenPath(), value, { mode: 0o600 });
  }

  async get(): Promise<string | null> {
    const path = this.tokenPath();
    if (!existsSync(path)) return null;
    try {
      const token = readFileSync(path, "utf-8").trim();
      return token || null;
    } catch {
      return null;
    }
  }

  async delete(): Promise<void> {
    const path = this.tokenPath();
    if (existsSync(path)) {
      try { unlinkSync(path); } catch {}
    }
  }
}
