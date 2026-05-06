import { describe, expect, test } from "bun:test";
import {
  ApiUnreachableError,
  AuthExpiredError,
  DEFAULT_API_TIMEOUT_MS,
  fetchWithTimeout,
  formatApiError,
  HoopApiClient,
} from "../src/api/client.ts";
import type { ApiError } from "../src/api/types.ts";

/**
 * The PRD goal is "fail open to native commands within 2-3s". We assert
 * both the typed-error contract and the actual elapsed time on a closed
 * port (which is the realistic blackhole case).
 */

describe("ApiUnreachableError", () => {
  test("is an Error subclass with reason + cause", () => {
    const e = new ApiUnreachableError("timeout", new Error("inner"));
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ApiUnreachableError);
    expect(e.name).toBe("ApiUnreachableError");
    expect(e.reason).toBe("timeout");
    expect(e.message).toContain("timeout");
    expect(e.cause).toBeInstanceOf(Error);
  });
});

describe("DEFAULT_API_TIMEOUT_MS", () => {
  test("is a short value matching the PRD's 2-3s goal", () => {
    // Locked down so a casual change doesn't accidentally regress to 30s.
    expect(DEFAULT_API_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    expect(DEFAULT_API_TIMEOUT_MS).toBeGreaterThanOrEqual(1500);
  });
});

describe("fetchWithTimeout", () => {
  test("classifies AbortSignal timeouts as ApiUnreachableError(timeout)", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      // Use a tiny timeout against a slow loopback server.
      // Pointing at a port that accepts but never responds is hard to set up
      // portably; instead use a real but slow target via 1ms timeout against
      // any responsive endpoint — Bun returns AbortError immediately.
      await fetchWithTimeout("http://127.0.0.1:1/", { timeoutMs: 1 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(ApiUnreachableError);
    // The error reason is one of: timeout (AbortSignal) or connection refused
    // (port 1 is closed). Either is a passthrough-eligible case.
    const reason = (caught as ApiUnreachableError).reason;
    expect(["timeout", "connection refused"]).toContain(reason);
    // Either way, must have failed fast.
    expect(elapsed).toBeLessThan(1000);
  });

  test("classifies closed port as ApiUnreachableError within budget", async () => {
    const start = Date.now();
    let caught: unknown;
    try {
      // Port 1 on loopback is closed → ECONNREFUSED.
      await fetchWithTimeout("http://127.0.0.1:1/", { timeoutMs: 3000 });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(ApiUnreachableError);
    // Repro case from the issue: must fail open in ~3s max.
    expect(elapsed).toBeLessThan(3500);
  });

  test("classifies DNS failure as ApiUnreachableError", async () => {
    let caught: unknown;
    try {
      // .invalid is reserved by RFC 6761 — must never resolve.
      await fetchWithTimeout("http://nothing.invalid./", { timeoutMs: 3000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiUnreachableError);
    // Reason should be "DNS failure" or "network error" depending on the
    // resolver's behavior — either is correct for failing open.
    const reason = (caught as ApiUnreachableError).reason;
    expect(typeof reason).toBe("string");
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe("HoopApiClient: error mapping", () => {
  test("listConnections() with closed port throws ApiUnreachableError", async () => {
    const client = new HoopApiClient("http://127.0.0.1:1", "tok");
    let caught: unknown;
    try {
      await client.listConnections();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiUnreachableError);
  });

  test("AuthExpiredError still propagates for 401/403 (regression guard)", async () => {
    // Spin up a tiny local server that returns 401.
    const server = Bun.serve({
      port: 0, // ephemeral
      fetch() {
        return new Response("nope", { status: 401 });
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

  test("non-401 HTTP errors do NOT classify as ApiUnreachableError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ message: "boom" }), {
          status: 500,
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
      // Should be the plain ApiError-shaped throw, not ApiUnreachableError.
      expect(caught).not.toBeInstanceOf(ApiUnreachableError);
      expect(caught).not.toBeInstanceOf(AuthExpiredError);
      // ApiError is `{ message, status }` — not a class instance.
      const c = caught as { message: string; status: number };
      expect(c.status).toBe(500);
      expect(c.message).toBe("boom");
    } finally {
      server.stop();
    }
  });

  test("happy path: 200 response decodes JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json([{ id: "a", name: "conn-1", type: "ssh" }]);
      },
    });
    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, "tok");
      const conns = await client.listConnections();
      expect(conns).toEqual([{ id: "a", name: "conn-1", type: "ssh" }]);
    } finally {
      server.stop();
    }
  });
});

/**
 * Regression: ENG-363. The `ApiError` thrown from `request()` is a plain
 * object, not an `Error` instance, so `String(err)` rendered as the
 * literal "[object Object]" and hid the actual gateway message. The
 * helper unwraps `.message` for objects, falls back to native `.message`
 * for `Error` subclasses, and stringifies anything else deterministically.
 */
describe("formatApiError", () => {
  test("returns .message for ApiError-shaped plain objects (the [object Object] bug)", () => {
    const err: ApiError = {
      message: "connection subtype is not supported for this connection",
      status: 400,
    };
    expect(formatApiError(err)).toBe(
      "connection subtype is not supported for this connection",
    );
    // Confirms the bug we're fixing: bare String() did the wrong thing.
    expect(String(err)).toBe("[object Object]");
  });

  test("returns .message for Error subclasses", () => {
    expect(formatApiError(new Error("boom"))).toBe("boom");
    expect(formatApiError(new TypeError("nope"))).toBe("nope");
  });

  test("returns .message for the typed errors thrown by this module", () => {
    expect(formatApiError(new ApiUnreachableError("timeout"))).toBe(
      "Hoop API unreachable: timeout",
    );
    expect(formatApiError(new AuthExpiredError())).toBe(
      "Authentication expired",
    );
  });

  test("stringifies bare strings and primitives", () => {
    expect(formatApiError("plain")).toBe("plain");
    expect(formatApiError(42)).toBe("42");
    expect(formatApiError(undefined)).toBe("undefined");
    expect(formatApiError(null)).toBe("null");
  });

  test("handles objects whose .message is non-string defensively", () => {
    // No throw, returns a deterministic representation. We don't care
    // about the exact format — only that it stays a string.
    const out = formatApiError({ message: { nested: true } });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("falls back to String() for objects without a .message field", () => {
    expect(formatApiError({ status: 500 })).toBe("[object Object]");
  });
});
