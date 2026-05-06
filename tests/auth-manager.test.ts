import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Tests for the auth manager's no-auto-OAuth contract (ENG-359).
 *
 * Pre-ENG-359, `ensureAuthenticated()` and `forceReauthenticate()`
 * called `performOAuthLogin()` automatically when the session was
 * missing/dead. This was disruptive: the user was mid-`ssh ...` or
 * `kubectl ...` and a browser window would suddenly pop. Now both
 * functions throw `AuthRequiredError` and the plugins are expected
 * to convert that into a clear "run hsh login" message + exit 77.
 *
 * The OAuth flow is still automatic for the `login()` function (used
 * by `hsh login`) — that's the one path where the user explicitly
 * asked for it.
 */

let tmpHome: string;
let originalHome: string | undefined;
let originalApiUrl: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "hsh-auth-mgr-test-"));
  originalHome = process.env.HSH_HOME;
  originalApiUrl = process.env.HSH_API_URL;
  process.env.HSH_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HSH_HOME;
  else process.env.HSH_HOME = originalHome;
  if (originalApiUrl === undefined) delete process.env.HSH_API_URL;
  else process.env.HSH_API_URL = originalApiUrl;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Write a config.json with a valid api-url so api-url checks pass. */
function configureApiUrl(url: string = "https://example.invalid"): void {
  writeFileSync(join(tmpHome, "config.json"), JSON.stringify({ apiUrl: url }));
}

/** Write an auth.json with the given expiresAt (ISO string). */
function writeAuth(expiresAt: string, token: string = "abc.def.ghi"): void {
  writeFileSync(
    join(tmpHome, "auth.json"),
    JSON.stringify({ token, expiresAt, email: "u@example.com" }),
  );
}

describe("AuthRequiredError", () => {
  test("is an Error subclass with name set", async () => {
    const { AuthRequiredError } = await import("../src/auth/manager.ts");
    const e = new AuthRequiredError();
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.name).toBe("AuthRequiredError");
    expect(e.message).toContain("expired");
  });

  test("accepts a custom message", async () => {
    const { AuthRequiredError } = await import("../src/auth/manager.ts");
    const e = new AuthRequiredError("something specific");
    expect(e.message).toBe("something specific");
  });
});

describe("ensureAuthenticated()", () => {
  test("throws AuthRequiredError when no auth.json exists (NO browser launch)", async () => {
    configureApiUrl();
    const { ensureAuthenticated, AuthRequiredError } = await import("../src/auth/manager.ts");
    let caught: unknown;
    try {
      await ensureAuthenticated();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthRequiredError);
  });

  test("throws AuthRequiredError when token is expired", async () => {
    configureApiUrl();
    // Wrote 1 hour in the past
    writeAuth(new Date(Date.now() - 3600 * 1000).toISOString());
    const { ensureAuthenticated, AuthRequiredError } = await import("../src/auth/manager.ts");
    let caught: unknown;
    try {
      await ensureAuthenticated();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthRequiredError);
  });

  test("returns the token when auth is valid", async () => {
    configureApiUrl();
    writeAuth(
      new Date(Date.now() + 3600 * 1000).toISOString(),
      "valid.token.here",
    );
    const { ensureAuthenticated } = await import("../src/auth/manager.ts");
    const token = await ensureAuthenticated();
    expect(token).toBe("valid.token.here");
  });
});

describe("forceReauthenticate()", () => {
  test("clears auth + sessions, then throws AuthRequiredError (NO browser launch)", async () => {
    configureApiUrl();
    writeAuth(new Date(Date.now() + 3600 * 1000).toISOString());
    // Plant a fake session file to verify it gets wiped.
    const sessDir = join(tmpHome, "sessions");
    mkdirSync(sessDir, { recursive: true });
    const sessFile = join(sessDir, "stale.json");
    writeFileSync(sessFile, "{}");

    const { forceReauthenticate, AuthRequiredError } = await import("../src/auth/manager.ts");
    let caught: unknown;
    try {
      await forceReauthenticate();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthRequiredError);
    // auth.json removed
    expect(existsSync(join(tmpHome, "auth.json"))).toBe(false);
    // session file removed
    expect(existsSync(sessFile)).toBe(false);
  });
});
