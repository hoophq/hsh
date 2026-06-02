import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileKeychain } from "../src/keychain/file.ts";
import { getKeychain, _resetKeychainCache } from "../src/keychain/auto.ts";

/**
 * Tests for the keychain abstraction layer (RD-184).
 *
 * We test the FileKeychain directly (it's the cross-platform fallback
 * and the backend used in CI) and the auto-detector's override logic.
 * macOS and Linux native backends are tested only on their respective
 * platforms — they require the real OS keychain daemon.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalKeychainBackend: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "hsh-keychain-test-"));
  originalHome = process.env.HSH_HOME;
  process.env.HSH_HOME = tmpHome;
  originalKeychainBackend = process.env.HSH_KEYCHAIN_BACKEND;
  process.env.HSH_KEYCHAIN_BACKEND = "file";
  _resetKeychainCache();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HSH_HOME;
  } else {
    process.env.HSH_HOME = originalHome;
  }
  if (originalKeychainBackend === undefined) {
    delete process.env.HSH_KEYCHAIN_BACKEND;
  } else {
    process.env.HSH_KEYCHAIN_BACKEND = originalKeychainBackend;
  }
  _resetKeychainCache();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// FileKeychain
// ---------------------------------------------------------------------------

describe("FileKeychain", () => {
  test("set/get round-trip", async () => {
    const kc = new FileKeychain();
    await kc.set("my-secret-token");
    expect(await kc.get()).toBe("my-secret-token");
  });

  test("get returns null when no token stored", async () => {
    const kc = new FileKeychain();
    expect(await kc.get()).toBeNull();
  });

  test("set overwrites previous value", async () => {
    const kc = new FileKeychain();
    await kc.set("first");
    await kc.set("second");
    expect(await kc.get()).toBe("second");
  });

  test("delete removes stored token", async () => {
    const kc = new FileKeychain();
    await kc.set("to-delete");
    await kc.delete();
    expect(await kc.get()).toBeNull();
  });

  test("delete is a no-op when no token exists", async () => {
    const kc = new FileKeychain();
    // Should not throw.
    await kc.delete();
    expect(await kc.get()).toBeNull();
  });

  test("token file is written with mode 0600", async () => {
    const kc = new FileKeychain();
    await kc.set("sensitive");
    const tokenPath = join(tmpHome, "token");
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("token file content is the raw token (no JSON wrapping)", async () => {
    const kc = new FileKeychain();
    const token = "eyJhbGciOiJSUzI1NiJ9.payload.sig";
    await kc.set(token);
    const raw = readFileSync(join(tmpHome, "token"), "utf-8").trim();
    expect(raw).toBe(token);
  });

  test("handles tokens containing newlines gracefully (trims)", async () => {
    const kc = new FileKeychain();
    await kc.set("tok\n");
    expect(await kc.get()).toBe("tok");
  });
});

// ---------------------------------------------------------------------------
// getKeychain / auto-detector
// ---------------------------------------------------------------------------

describe("getKeychain auto-detector", () => {
  test("HSH_KEYCHAIN_BACKEND=file returns FileKeychain", () => {
    process.env.HSH_KEYCHAIN_BACKEND = "file";
    _resetKeychainCache();
    expect(getKeychain().name).toBe("file (fallback)");
  });

  test("unknown HSH_KEYCHAIN_BACKEND falls back to platform auto-detect", () => {
    process.env.HSH_KEYCHAIN_BACKEND = "bogus-value";
    _resetKeychainCache();
    // Should not throw — logs a warning and auto-detects.
    const kc = getKeychain();
    expect(kc).toBeDefined();
    expect(typeof kc.name).toBe("string");
  });

  test("result is cached after first call", () => {
    process.env.HSH_KEYCHAIN_BACKEND = "file";
    _resetKeychainCache();
    const first = getKeychain();
    const second = getKeychain();
    expect(first).toBe(second); // same object reference
  });

  test("_resetKeychainCache forces re-detection on next call", () => {
    process.env.HSH_KEYCHAIN_BACKEND = "file";
    _resetKeychainCache();
    const first = getKeychain();
    _resetKeychainCache();
    const second = getKeychain();
    // Different object instances after reset.
    expect(first).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// auth/store integration — uses keychain via getKeychain()
// ---------------------------------------------------------------------------

describe("auth/store via FileKeychain", () => {
  // Import dynamically so HSH_HOME + HSH_KEYCHAIN_BACKEND are already set.
  test("saveToken stores token in keychain, metadata in auth.json (no token field)", async () => {
    const { saveToken } = await import("../src/auth/store.ts");
    const expires = new Date(Date.now() + 3600_000).toISOString();
    await saveToken("my.jwt.token", expires, "user@example.com");

    // Token should be in ~/.hsh/token (FileKeychain), not auth.json.
    const tokenPath = join(tmpHome, "token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf-8").trim()).toBe("my.jwt.token");

    const authPath = join(tmpHome, "auth.json");
    expect(existsSync(authPath)).toBe(true);
    const meta = JSON.parse(readFileSync(authPath, "utf-8")) as {
      token?: string;
      expiresAt: string;
      email?: string;
    };
    expect(meta.token).toBeUndefined();
    expect(meta.expiresAt).toBe(expires);
    expect(meta.email).toBe("user@example.com");
  });

  test("getToken returns stored token when not expired", async () => {
    const { saveToken, getToken } = await import("../src/auth/store.ts");
    const expires = new Date(Date.now() + 3600_000).toISOString();
    await saveToken("valid.jwt.tok", expires);
    expect(await getToken()).toBe("valid.jwt.tok");
  });

  test("getToken returns null when token is expired", async () => {
    const { saveToken, getToken } = await import("../src/auth/store.ts");
    // Expired 2 minutes ago.
    const expires = new Date(Date.now() - 120_000).toISOString();
    await saveToken("expired.jwt.tok", expires);
    expect(await getToken()).toBeNull();
  });

  test("getToken returns null when no auth.json exists", async () => {
    const { getToken } = await import("../src/auth/store.ts");
    expect(await getToken()).toBeNull();
  });

  test("clearToken removes both keychain token and auth.json", async () => {
    const { saveToken, clearToken, getToken } = await import("../src/auth/store.ts");
    const expires = new Date(Date.now() + 3600_000).toISOString();
    await saveToken("tok", expires);
    await clearToken();
    expect(await getToken()).toBeNull();
    expect(existsSync(join(tmpHome, "token"))).toBe(false);
    expect(existsSync(join(tmpHome, "auth.json"))).toBe(false);
  });

  test("legacy migration: token in auth.json is moved to keychain on getToken()", async () => {
    const { getToken } = await import("../src/auth/store.ts");
    const { safeWriteJson } = await import("../src/util/safe-write.ts");

    // Write the old format (with token inline in auth.json).
    const legacyToken = "legacy.jwt.tok";
    const expires = new Date(Date.now() + 3600_000).toISOString();
    safeWriteJson(join(tmpHome, "auth.json"), {
      token: legacyToken,
      expiresAt: expires,
      email: "old@example.com",
    }, { mode: 0o600 });

    // getToken() should migrate and return the token.
    const tok = await getToken();
    expect(tok).toBe(legacyToken);

    // After migration: token is in keychain file, removed from auth.json.
    const tokenPath = join(tmpHome, "token");
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf-8").trim()).toBe(legacyToken);

    const meta = JSON.parse(readFileSync(join(tmpHome, "auth.json"), "utf-8")) as {
      token?: string;
      expiresAt: string;
    };
    expect(meta.token).toBeUndefined();
    expect(meta.expiresAt).toBe(expires);
  });
});
