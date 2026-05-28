/**
 * tests/dashboard.test.ts — unit tests for the dashboard server.
 *
 * We exercise the HTTP surface directly via the fetch callback that
 * buildServer returns. No real TunnelClient — we pass in a fake
 * implementing only the methods the server touches. No real network
 * either — the fetch callback is invoked synchronously with
 * fabricated Requests.
 */

import { describe, expect, test } from "bun:test";

import { buildServer } from "../src/dashboard/server";
import { csrfToken } from "../src/dashboard/csrf";
import { renderCommand } from "../src/dashboard/commands";

/**
 * fakeClient is a duck-typed TunnelClient. We only expose what the
 * server actually calls; tests that need a custom response shape
 * pass overrides via the constructor.
 */
function fakeClient(
  overrides: Partial<Record<string, (...args: any[]) => Promise<any>>> = {},
): any {
  // The fake's method signatures vary (loginPoll takes a state
  // string; status takes nothing). We type as the union of
  // (...args: any[]) so the override map accepts any of them.
  const defaults: Record<string, (...args: any[]) => Promise<any>> = {
    status: async () => ({
      running: true,
      logged_in: true,
      since: "2026-05-28T12:00:00Z",
      daemon_version: "v0.0.1",
    }),
    connections: async () => [
      {
        name: "test-pg",
        subtype: "postgres",
        virtual_ip: "fd00::1",
        expected_port: 5432,
      },
    ],
    loginStart: async () => ({
      state: "abcdef",
      browser_url: "https://gateway.example/oauth",
    }),
    loginPoll: async (state: string) => ({ status: "pending", state }),
    logout: async () => undefined,
  };
  return { ...defaults, ...overrides };
}

function makeServer(opts: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer({
    hostname: "127.0.0.1",
    port: 0,
    client: opts.client ?? (fakeClient() as any),
    userName: opts.userName ?? "alice",
  });
}

function req(
  method: string,
  path: string,
  opts: { csrf?: boolean; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.csrf) headers["X-CSRF-Token"] = csrfToken();
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("dashboard server: static assets", () => {
  test("GET / returns HTML with the CSRF token stamped in", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
    const body = await resp.text();
    expect(body).toContain(`<meta name="csrf-token"`);
    expect(body).toContain(csrfToken());
  });

  test("GET /assets/styles.css returns CSS", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/assets/styles.css"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/css");
    expect((await resp.text()).length).toBeGreaterThan(100);
  });

  test("GET /assets/app.js returns JS", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/assets/app.js"));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/javascript");
  });

  test("unknown path returns 404 JSON", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/nope"));
    expect(resp.status).toBe(404);
    const body = (await resp.json()) as any;
    expect(body.message).toBe("not found");
  });
});

describe("dashboard server: API proxies (GET)", () => {
  test("GET /api/status forwards to client.status()", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/api/status"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.running).toBe(true);
    expect(body.logged_in).toBe(true);
    expect(body.daemon_version).toBe("v0.0.1");
  });

  test("GET /api/connections forwards to client.connections()", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/api/connections"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].name).toBe("test-pg");
  });

  test("GET /api/login/poll requires state query param", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/api/login/poll"));
    expect(resp.status).toBe(400);
  });

  test("GET /api/login/poll passes state through", async () => {
    let observedState = "";
    const client = fakeClient({
      loginPoll: async (state: string) => {
        observedState = state;
        return { status: "pending", state };
      },
    });
    const server = makeServer({ client });
    const resp = await server.fetch(req("GET", "/api/login/poll?state=xyz"));
    expect(resp.status).toBe(200);
    expect(observedState).toBe("xyz");
  });
});

describe("dashboard server: CSRF gate", () => {
  test("POST /api/logout without CSRF -> 403", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("POST", "/api/logout"));
    expect(resp.status).toBe(403);
  });

  test("POST /api/logout with valid CSRF -> 204", async () => {
    const server = makeServer();
    const resp = await server.fetch(
      req("POST", "/api/logout", { csrf: true }),
    );
    expect(resp.status).toBe(204);
  });

  test("POST /api/login/start without CSRF -> 403", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("POST", "/api/login/start"));
    expect(resp.status).toBe(403);
  });

  test("POST /api/login/start with CSRF -> 200 + browser_url", async () => {
    const server = makeServer();
    const resp = await server.fetch(
      req("POST", "/api/login/start", { csrf: true }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.browser_url).toContain("https://");
  });
});

describe("dashboard server: command rendering", () => {
  test("GET /api/commands/postgres?name=foo -> renders psql", async () => {
    const server = makeServer({ userName: "alice" });
    const resp = await server.fetch(
      req("GET", "/api/commands/postgres?name=foo"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.command).toContain("psql");
    expect(body.command).toContain("foo.hoop");
    expect(body.command).toContain("alice");
  });

  test("GET /api/commands/unknown -> 404", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/api/commands/oracle9000?name=foo"));
    expect(resp.status).toBe(404);
  });

  test("GET /api/commands/mysql without name -> 400", async () => {
    const server = makeServer();
    const resp = await server.fetch(req("GET", "/api/commands/mysql"));
    expect(resp.status).toBe(400);
  });
});

describe("renderCommand: subtype coverage", () => {
  const subtypes = [
    "postgres",
    "mysql",
    "mssql",
    "mongodb",
    "oracledb",
    "tcp",
  ] as const;

  for (const subtype of subtypes) {
    test(`${subtype}: produces a non-empty command with the host appended`, () => {
      const cmd = renderCommand({
        name: "demo",
        subtype,
        userName: "alice",
      });
      expect(cmd.length).toBeGreaterThan(0);
      expect(cmd).toContain("demo.hoop");
    });
  }

  test("postgres + alice -> includes -U alice", () => {
    expect(
      renderCommand({ name: "demo", subtype: "postgres", userName: "alice" }),
    ).toContain("-U alice");
  });

  test("mysql + bob -> includes -u bob", () => {
    expect(
      renderCommand({ name: "demo", subtype: "mysql", userName: "bob" }),
    ).toContain("-u bob");
  });
});
