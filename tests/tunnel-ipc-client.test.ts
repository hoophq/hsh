/**
 * tests/tunnel-ipc-client.test.ts — unit tests for the TunnelClient
 * IPC wrapper, focused on the up/down lifecycle endpoints and the
 * not-logged-in (409) error mapping added alongside them.
 *
 * We stub global.fetch so no real unix socket or daemon is needed. The
 * client is constructed directly (not via connect()) with explicit
 * socketPath/token so we skip the filesystem token-read path.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { TunnelApiError, TunnelClient } from "../src/tunnel/ipc-client.ts";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

function newClient(): TunnelClient {
  return new TunnelClient({ socketPath: "/tmp/fake.sock", token: "test-token" });
}

/**
 * Install a fake fetch that records the request and returns the given
 * status + JSON body. Returns a getter for the captured request so
 * tests can assert method/path/headers.
 */
function stubFetch(status: number, body: unknown): () => { url: string; init: RequestInit } {
  let captured: { url: string; init: RequestInit } | undefined;
  global.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    const text = body === undefined ? "" : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return () => {
    if (!captured) throw new Error("fetch was not called");
    return captured;
  };
}

describe("TunnelClient.up", () => {
  test("POSTs /v1/tunnel/up and returns the parsed response", async () => {
    const getReq = stubFetch(200, { running: true, already_up: false });
    const resp = await newClient().up();

    expect(resp.running).toBe(true);
    expect(resp.already_up).toBe(false);

    const { url, init } = getReq();
    expect(url).toBe("http://hsh-tunneld/v1/tunnel/up");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token"
    );
  });

  test("surfaces already_up=true when the tunnel was already running", async () => {
    stubFetch(200, { running: true, already_up: true });
    const resp = await newClient().up();
    expect(resp.already_up).toBe(true);
  });

  test("throws TunnelApiError with isNotLoggedIn() on 409 not_logged_in", async () => {
    stubFetch(409, { error: "ipc: not logged in", code: "not_logged_in" });

    let caught: unknown;
    try {
      await newClient().up();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TunnelApiError);
    const apiErr = caught as TunnelApiError;
    expect(apiErr.isNotLoggedIn()).toBe(true);
    expect(apiErr.isUnauthorized()).toBe(false);
    expect(apiErr.statusCode).toBe(409);
  });

  test("a 401 is NOT treated as not-logged-in (control-token rejection)", async () => {
    stubFetch(401, { error: "unauthorized", code: "unauthorized" });

    let caught: unknown;
    try {
      await newClient().up();
    } catch (err) {
      caught = err;
    }
    const apiErr = caught as TunnelApiError;
    expect(apiErr.isUnauthorized()).toBe(true);
    expect(apiErr.isNotLoggedIn()).toBe(false);
  });
});

describe("TunnelClient.down", () => {
  test("POSTs /v1/tunnel/down and returns the parsed response", async () => {
    const getReq = stubFetch(200, { already_down: false });
    const resp = await newClient().down();

    expect(resp.already_down).toBe(false);
    const { url, init } = getReq();
    expect(url).toBe("http://hsh-tunneld/v1/tunnel/down");
    expect(init.method).toBe("POST");
  });

  test("surfaces already_down=true when the tunnel was already idle", async () => {
    stubFetch(200, { already_down: true });
    const resp = await newClient().down();
    expect(resp.already_down).toBe(true);
  });
});

describe("TunnelClient.refreshConnections", () => {
  test("POSTs /v1/connections/refresh and returns the parsed response", async () => {
    const getReq = stubFetch(200, { running: true, count: 4 });
    const resp = await newClient().refreshConnections();

    expect(resp.running).toBe(true);
    expect(resp.count).toBe(4);
    const { url, init } = getReq();
    expect(url).toBe("http://hsh-tunneld/v1/connections/refresh");
    expect(init.method).toBe("POST");
  });

  test("reports running=false when the tunnel is down (no-op)", async () => {
    stubFetch(200, { running: false, count: 0 });
    const resp = await newClient().refreshConnections();
    expect(resp.running).toBe(false);
    expect(resp.count).toBe(0);
  });
});
