import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { performLocalAuthLogin } from "../src/auth/local.ts";
import { _resetKeychainCache } from "../src/keychain/auto.ts";

/**
 * Wire-contract + UX tests for local-auth login.
 *
 * Source of truth for the wire format: hoophq/hoop
 * `gateway/api/login/local/login.go`. The endpoint is
 * `POST /api/localauth/login` with `{email, password}` JSON; on 200 OK
 * it returns the JWT in the `Token` response header (plus
 * `Access-Control-Expose-Headers: Token` so browsers can read it).
 *
 * These tests stand in a Bun.serve fake gateway and a temp HSH_HOME so
 * we never touch the user's real auth.json.
 *
 * Stdin/stdout are stubbed at module load via the streams-injection API
 * exposed by performLocalAuthLogin's callees (promptLine/promptPassword).
 * We stub the global process.stdin since performLocalAuthLogin doesn't
 * accept streams directly — keeping its public signature minimal.
 */

import { PassThrough } from "stream";

let tempHome: string;
let originalHome: string | undefined;
let originalKeychainBackend: string | undefined;
let originalExit: typeof process.exit;
let originalStdin: typeof process.stdin;

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code}) called`);
    this.name = "ExitCalled";
    this.code = code;
  }
}

beforeAll(() => {
  // Isolate auth.json under a temp HSH_HOME so test runs don't clobber
  // the developer's real session. Note: HSH_HOME is read by config/store
  // *at module load time* (Bun caches homedir resolution); for these
  // tests we tolerate the cached value and instead point at a tempdir
  // we own end-to-end.
  tempHome = mkdtempSync(join(tmpdir(), "hsh-local-auth-test-"));
  originalHome = process.env.HSH_HOME;
  process.env.HSH_HOME = tempHome;
  // Force file backend so tests don't touch the real OS keychain.
  originalKeychainBackend = process.env.HSH_KEYCHAIN_BACKEND;
  process.env.HSH_KEYCHAIN_BACKEND = "file";
  _resetKeychainCache();
  originalStdin = process.stdin;

  // Stub process.exit so the test can observe exit codes instead of
  // killing the test runner.
  originalExit = process.exit;
  process.exit = ((code?: number): never => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;
});

afterAll(() => {
  process.exit = originalExit;
  if (originalHome !== undefined) {
    process.env.HSH_HOME = originalHome;
  } else {
    delete process.env.HSH_HOME;
  }
  if (originalKeychainBackend !== undefined) {
    process.env.HSH_KEYCHAIN_BACKEND = originalKeychainBackend;
  } else {
    delete process.env.HSH_KEYCHAIN_BACKEND;
  }
  _resetKeychainCache();
  Object.defineProperty(process, "stdin", {
    value: originalStdin,
    configurable: true,
  });
  rmSync(tempHome, { recursive: true, force: true });
});

afterEach(() => {
  // Drop persisted token state from the previous test so each starts clean.
  try { rmSync(join(tempHome, "auth.json"), { force: true }); } catch {}
  try { rmSync(join(tempHome, "token"), { force: true }); } catch {}
});

function stubStdin(): PassThrough {
  const fake = new PassThrough();
  Object.defineProperty(process, "stdin", {
    value: fake,
    configurable: true,
  });
  return fake;
}

/**
 * A non-expired JWT with a known email claim. Generated with random
 * dummy signature; the local store doesn't verify the signature, just
 * decodes the payload to extract `exp` and `email`.
 */
function makeFakeJwt(email: string, expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ email, sub: email, exp: expSec, iat: Math.floor(Date.now() / 1000) }),
  ).toString("base64url");
  const sig = "x".repeat(86); // dummy signature
  return `${header}.${payload}.${sig}`;
}

describe("performLocalAuthLogin (ENG-362)", () => {
  test("happy path: prompts, POSTs JSON, persists token from Token response header", async () => {
    const captured: { method?: string; body?: { email?: string; password?: string } } = {};

    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const jwt = makeFakeJwt("alice@example.com", expSec);

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.method = req.method;
        captured.body = (await req.json()) as { email?: string; password?: string };
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            // Match the gateway's actual contract: case-sensitive
            // `Token` header. Headers.get() is case-insensitive.
            Token: jwt,
            "Access-Control-Expose-Headers": "Token",
          },
        });
      },
    });

    try {
      const stdin = stubStdin();
      const promise = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      // Drive the prompts. The implementation calls promptLine then
      // promptPassword in sequence; each completes on '\n'.
      stdin.write("alice@example.com\n");
      stdin.write("hunter2\n");
      await promise;

      expect(captured.method).toBe("POST");
      expect(captured.body).toEqual({
        email: "alice@example.com",
        password: "hunter2",
      });

      // Token is stored in the keychain (file backend in tests: ~/.hsh/token).
      // auth.json holds only metadata — no token field.
      const storedToken = readFileSync(join(tempHome, "token"), "utf-8").trim();
      expect(storedToken).toBe(jwt);

      const meta = JSON.parse(
        readFileSync(join(tempHome, "auth.json"), "utf-8"),
      ) as { token?: string; email?: string; expiresAt: string };
      expect(meta.token).toBeUndefined();
      expect(meta.email).toBe("alice@example.com");
      expect(new Date(meta.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      server.stop();
    }
  });

  test("trims whitespace from email but NOT from password", async () => {
    const captured: { body?: { email?: string; password?: string } } = {};
    const jwt = makeFakeJwt("bob@example.com", Math.floor(Date.now() / 1000) + 3600);

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.body = (await req.json()) as { email?: string; password?: string };
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json", Token: jwt },
        });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write("  bob@example.com  \n"); // padded — should be trimmed
      stdin.write("  pa ss  \n"); // password preserved verbatim
      await p;
      expect(captured.body?.email).toBe("bob@example.com");
      expect(captured.body?.password).toBe("  pa ss  ");
    } finally {
      server.stop();
    }
  });

  test("401 invalid credentials → exits 1 with generic 'Invalid email or password'", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ message: "invalid credentials" }, { status: 401 });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write("alice@example.com\n");
      stdin.write("wrong\n");
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("404 user not found → also generic 'Invalid email or password' (no enumeration leak)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ message: "user not found" }, { status: 404 });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write("ghost@example.com\n");
      stdin.write("anything\n");
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("200 OK without Token header → exits 1 (defensive: gateway misbehavior)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        // 200 OK but the gateway forgot to set the header.
        return Response.json({ status: "ok" }, { status: 200 });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write("alice@example.com\n");
      stdin.write("hunter2\n");
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(1);
    } finally {
      server.stop();
    }
  });

  test("empty email → exits 1 before any HTTP call", async () => {
    let serverHit = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        serverHit = true;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write("\n"); // empty email
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ExitCalled);
      expect(serverHit).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("Ctrl-C at email prompt → exits 1, no HTTP call", async () => {
    let serverHit = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        serverHit = true;
        return new Response("nope", { status: 500 });
      },
    });
    try {
      const stdin = stubStdin();
      const p = performLocalAuthLogin(`http://127.0.0.1:${server.port}`);
      stdin.write(Buffer.from([0x03])); // Ctrl-C
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(ExitCalled);
      expect(serverHit).toBe(false);
    } finally {
      server.stop();
    }
  });
});
