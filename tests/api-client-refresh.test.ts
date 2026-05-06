import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  HoopApiClient,
  NEW_ACCESS_TOKEN_HEADER,
  AuthExpiredError,
  createClient,
} from "../src/api/client.ts";

/**
 * Tests for the silent JWT-refresh path (ENG-349).
 *
 * The Hoop gateway transparently refreshes expired access tokens using
 * the server-side OIDC refresh token, then ships the new access token
 * back via the `X-New-Access-Token` response header. The client just
 * needs to:
 *
 *   1. Read the header on every response.
 *   2. Persist the new token (atomic write — same path as auth.json).
 *   3. Use the new token on subsequent requests in the same process.
 *
 * Reference: hoophq/hoop PR #1415 (gateway/api/apiroutes/auth.go).
 *
 * These tests use Bun.serve to spin up a fake gateway on an ephemeral
 * port. We don't need a real JWT signature — the client only does a
 * cheap shape check (3 dot-separated segments) before persisting.
 */

/**
 * Build a JWT-shaped string with a base64url-encoded `{"exp": ...}`
 * payload. The signature is gibberish — not validated client-side.
 * `expSeconds` is the unix timestamp (seconds) for the `exp` claim;
 * default = +1h from now so the rotated token looks "fresh" when
 * persisted to auth.json (which decodes `exp` to compute expiresAt).
 */
function makeJwt(expSeconds: number = Math.floor(Date.now() / 1000) + 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, sub: "test-user" }))
    .toString("base64url");
  // Signature segment is opaque — server never validates the client's view of it.
  return `${header}.${payload}.signature-not-validated-clientside`;
}

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  // Each test gets a hermetic HSH_HOME so persisted auth.json from
  // one test doesn't bleed into another.
  tmpHome = mkdtempSync(join(tmpdir(), "hsh-refresh-test-"));
  originalHome = process.env.HSH_HOME;
  process.env.HSH_HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HSH_HOME;
  } else {
    process.env.HSH_HOME = originalHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("HoopApiClient: X-New-Access-Token rotation (ENG-349)", () => {
  test("rotates in-memory token when gateway sends X-New-Access-Token on 200", async () => {
    const oldToken = "old.token.sig";
    const newToken = makeJwt();
    const seenAuthHeaders: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuthHeaders.push(req.headers.get("Authorization") ?? "<none>");
        // First request: include X-New-Access-Token in response.
        // Second request: don't (so we can verify the rotation stuck).
        const headers = new Headers({ "Content-Type": "application/json" });
        if (seenAuthHeaders.length === 1) {
          headers.set(NEW_ACCESS_TOKEN_HEADER, newToken);
        }
        return new Response(JSON.stringify([]), { status: 200, headers });
      },
    });

    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, oldToken);
      expect(client.getToken()).toBe(oldToken);

      // First request → server returns rotation header
      await client.listConnections();
      expect(client.getToken()).toBe(newToken);

      // Second request → must use rotated token (verifies the in-memory
      // swap actually feeds the next Authorization header)
      await client.listConnections();
      expect(seenAuthHeaders[0]).toBe(`Bearer ${oldToken}`);
      expect(seenAuthHeaders[1]).toBe(`Bearer ${newToken}`);
    } finally {
      server.stop();
    }
  });

  test("calls onTokenRefreshed handler exactly once per rotation", async () => {
    const newToken = makeJwt();
    let handlerCalls = 0;
    let handlerArg = "";

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: newToken },
        });
      },
    });

    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "old.token.sig",
        (t) => {
          handlerCalls++;
          handlerArg = t;
        },
      );
      await client.listConnections();
      expect(handlerCalls).toBe(1);
      expect(handlerArg).toBe(newToken);
    } finally {
      server.stop();
    }
  });

  test("does NOT call handler when header is absent", async () => {
    let handlerCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "tok",
        () => { handlerCalls++; },
      );
      await client.listConnections();
      expect(handlerCalls).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("ignores empty-string X-New-Access-Token (defensive)", async () => {
    let handlerCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: "   " }, // whitespace
        });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "tok",
        () => { handlerCalls++; },
      );
      await client.listConnections();
      // Empty header → no rotation, keep old token.
      expect(handlerCalls).toBe(0);
      expect(client.getToken()).toBe("tok");
    } finally {
      server.stop();
    }
  });

  test("ignores malformed (non-JWT-shape) X-New-Access-Token", async () => {
    let handlerCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        // Not three dot-separated segments — clearly not a JWT.
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: "garbage" },
        });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "tok",
        () => { handlerCalls++; },
      );
      await client.listConnections();
      expect(handlerCalls).toBe(0);
      expect(client.getToken()).toBe("tok");
    } finally {
      server.stop();
    }
  });

  test("ignores rotation when server echoes the same token (no-op)", async () => {
    const same = makeJwt();
    let handlerCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: same },
        });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        same, // start with the same token
        () => { handlerCalls++; },
      );
      await client.listConnections();
      // Same token in == same token out: no-op, no persist.
      expect(handlerCalls).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("default handler persists rotated token to auth.json (atomic write)", async () => {
    const newToken = makeJwt();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: newToken },
        });
      },
    });
    try {
      // No custom handler → uses defaultTokenRefreshHandler → saveTokenFromJwt
      const client = createClient(`http://127.0.0.1:${server.port}`, "tok");
      await client.listConnections();

      const authPath = join(tmpHome, "auth.json");
      expect(existsSync(authPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(authPath, "utf-8")) as {
        token: string;
        expiresAt: string;
      };
      expect(persisted.token).toBe(newToken);
      // The exp we encoded into the JWT should be reflected in expiresAt
      // (within a second of "now + 1h").
      const expiresMs = new Date(persisted.expiresAt).getTime();
      const expectedMs = Date.now() + 3600 * 1000;
      expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(2000);
    } finally {
      server.stop();
    }
  });

  test("401 still throws AuthExpiredError (refresh-token-also-dead path)", async () => {
    // Even with the X-New-Access-Token mechanism, the gateway returns
    // 401 when its own refresh attempt fails. Client must propagate
    // AuthExpiredError so plugins can show the "run hsh login" UX.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ message: "access denied" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, "tok");
      let caught: unknown;
      try {
        await client.listConnections();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AuthExpiredError);
    } finally {
      server.stop();
    }
  });

  test("X-New-Access-Token on a 4xx response is still consumed", async () => {
    // Gateway middleware writes the header BEFORE delegating to the
    // real handler, which may then return non-2xx. The client must
    // still pick up the rotated token even when the request itself
    // failed — otherwise the next request would still use the old
    // (expired) token and trigger a fresh round-trip.
    const newToken = makeJwt();
    let handlerCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            [NEW_ACCESS_TOKEN_HEADER]: newToken,
          },
        });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "tok",
        () => { handlerCalls++; },
      );
      let caught: unknown;
      try {
        await client.listConnections();
      } catch (e) {
        caught = e;
      }
      // The original error still surfaces.
      expect(caught).toBeDefined();
      // But the rotation took effect.
      expect(handlerCalls).toBe(1);
      expect(client.getToken()).toBe(newToken);
    } finally {
      server.stop();
    }
  });

  test("persistence failures don't crash the request (degrade to in-memory only)", async () => {
    const newToken = makeJwt();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { [NEW_ACCESS_TOKEN_HEADER]: newToken },
        });
      },
    });
    try {
      const client = new HoopApiClient(
        `http://127.0.0.1:${server.port}`,
        "tok",
        () => {
          // Simulate disk-full / EACCES — the request must still succeed
          // and the in-memory rotation must still happen.
          throw new Error("disk full");
        },
      );
      // No throw — request returns normally.
      const conns = await client.listConnections();
      expect(conns).toEqual([]);
      // In-memory rotation still happened.
      expect(client.getToken()).toBe(newToken);
    } finally {
      server.stop();
    }
  });
});
