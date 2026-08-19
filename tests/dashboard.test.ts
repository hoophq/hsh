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
        username: "noop",
        password: "noop",
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
  test("GET /api/commands/postgres?name=test-pg -> psql with the daemon's credentials", async () => {
    const server = makeServer();
    const resp = await server.fetch(
      req("GET", "/api/commands/postgres?name=test-pg"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { command: string };
    expect(body.command).toContain("psql");
    expect(body.command).toContain("test-pg.hoop");
    // The credentials come from the daemon's record, never from the
    // shell-level user the dashboard happens to run as.
    expect(body.command).toContain("-U noop");
    expect(body.command).toContain("PGPASSWORD=noop");
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

  test("GET /api/commands for a connection the daemon does not serve -> 404", async () => {
    const server = makeServer();
    const resp = await server.fetch(
      req("GET", "/api/commands/postgres?name=not-a-connection"),
    );
    expect(resp.status).toBe(404);
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
    "httpproxy",
  ] as const;

  for (const subtype of subtypes) {
    test(`${subtype}: produces a non-empty command with the host appended`, () => {
      const cmd = renderCommand({
        name: "demo",
        subtype,
        username: "noop",
        password: "noop",
        expectedPort: 1521,
      });
      expect(cmd.length).toBeGreaterThan(0);
      expect(cmd).toContain("demo.hoop");
    });
  }

  // Each protocol's client takes its credentials differently, and getting
  // the syntax wrong yields a command that silently prompts or fails. Pin
  // the exact flag shape per client.
  const credentialSyntax: Array<{
    subtype: (typeof subtypes)[number];
    want: string[];
  }> = [
    { subtype: "postgres", want: ["PGPASSWORD=s3cret", "-U hoopuser"] },
    // mysql glues the password to -p with no space.
    { subtype: "mysql", want: ["-u hoopuser", "-ps3cret"] },
    { subtype: "mssql", want: ["-U hoopuser", "-P s3cret"] },
    { subtype: "mongodb", want: ["mongodb://hoopuser:s3cret@", "directConnection=true"] },
    { subtype: "oracledb", want: ["hoopuser/s3cret@demo.hoop:1521"] },
  ];

  for (const { subtype, want } of credentialSyntax) {
    test(`${subtype}: embeds the supplied credentials in the client's own syntax`, () => {
      const cmd = renderCommand({
        name: "demo",
        subtype,
        username: "hoopuser",
        password: "s3cret",
        expectedPort: 1521,
      });
      for (const fragment of want) {
        expect(cmd).toContain(fragment);
      }
    });
  }

  // `tcp` is relayed verbatim: Hoop injects no credentials, so advertising
  // any would send the user down a dead end.
  test("tcp: carries no credentials", () => {
    const cmd = renderCommand({
      name: "demo",
      subtype: "tcp",
      username: "",
      password: "",
      expectedPort: 0,
    });
    expect(cmd).not.toContain("noop");
  });
});

describe("renderCommand: daemon without credentials", () => {
  // A daemon older than the credentials field omits username/password from
  // /v1/connections. TunnelClient casts the raw JSON without validating, so
  // the fields are `undefined` at runtime despite the types. Rendering them
  // produced "PGPASSWORD=undefined psql -U undefined".
  const legacySubtypes = [
    "postgres",
    "mysql",
    "mssql",
    "mongodb",
    "oracledb",
  ] as const;

  for (const subtype of legacySubtypes) {
    test(`${subtype}: omitted credentials never render as undefined`, () => {
      const cmd = renderCommand({
        name: "demo",
        subtype,
        // Exactly what an older daemon yields after the JSON cast.
        username: undefined as unknown as string,
        password: undefined as unknown as string,
        expectedPort: 1521,
      });
      expect(cmd).not.toContain("undefined");
      expect(cmd).toContain("demo.hoop");
      expect(cmd.length).toBeGreaterThan(0);
    });

    test(`${subtype}: empty credentials render a usable command`, () => {
      const cmd = renderCommand({
        name: "demo",
        subtype,
        username: "",
        password: "",
        expectedPort: 1521,
      });
      // No dangling flag with nothing after it (e.g. "-U " at end of line).
      expect(cmd).not.toMatch(/(-U|-u|-P)\s*$/);
      expect(cmd).not.toContain("://:@");
      expect(cmd).toContain("demo.hoop");
    });
  }
});
