import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

/**
 * `hsh kubeconfig <connection>` — the workaround command for kubectl-wrapping
 * tools (helm, k9s, kustomize, Lens, skaffold) that bypass the shell function.
 * These tests run the real binary against a stubbed Hoop API.
 *
 * Strategy: spin up a tiny `Bun.serve` API stub on an ephemeral port, point
 * `hsh config set api-url` at it, plant a fake JWT in `~/.hsh/auth.json`, then
 * `Bun.spawn` the kubeconfig command. The stub returns canned connection +
 * credential responses so we can assert the resulting kubeconfig path is
 * correct, well-formed, and only the path appears on stdout.
 */

let tmpHshHome: string;
const realHshHome = process.env.HSH_HOME;

beforeEach(() => {
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-kubeconfig-cmd-"));
  process.env.HSH_HOME = tmpHshHome;
});

afterEach(() => {
  if (realHshHome !== undefined) process.env.HSH_HOME = realHshHome;
  else delete process.env.HSH_HOME;
  rmSync(tmpHshHome, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface StubOpts {
  /** Connection list returned by /api/connections. */
  connections: Array<{ id: string; name: string; type: string }>;
  /** Per-connection credential response. */
  credentials: Record<
    string,
    {
      connection_credentials?: {
        hostname: string;
        port: string;
        proxy_token: string;
        command: string;
      };
      has_review?: boolean;
      review_id?: string;
    }
  >;
}

async function withStubApi<T>(
  opts: StubOpts,
  fn: (apiUrl: string) => Promise<T>,
): Promise<T> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/connections") {
        return Response.json(opts.connections);
      }
      const m = url.pathname.match(
        /^\/api\/connections\/([^/]+)\/credentials$/
      );
      if (m && req.method === "POST") {
        const name = decodeURIComponent(m[1]);
        const cred = opts.credentials[name];
        if (!cred) return new Response("not found", { status: 404 });
        return Response.json({
          id: "cred-" + name,
          connection_name: name,
          connection_type: "kubernetes",
          connection_sub_type: "kubernetes",
          session_id: "sess-1",
          has_review: cred.has_review ?? false,
          review_id: cred.review_id,
          created_at: new Date().toISOString(),
          expire_at: new Date(Date.now() + 3600_000).toISOString(),
          connection_credentials: cred.connection_credentials,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    server.stop();
  }
}

function plantAuth(apiUrl: string): void {
  const { mkdirSync, writeFileSync } = require("fs");
  mkdirSync(tmpHshHome, { recursive: true });
  // A token whose middle segment decodes as { exp: future }.
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const token = `header.${payload}.sig`;
  writeFileSync(
    join(tmpHshHome, "auth.json"),
    JSON.stringify({
      token,
      expiresAt: new Date(exp * 1000).toISOString(),
    }) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(
    join(tmpHshHome, "config.json"),
    JSON.stringify({ apiUrl }) + "\n",
    { mode: 0o600 },
  );
}

function runHsh(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", "src/index.ts", ...args], {
      env: {
        ...process.env,
        HSH_HOME: tmpHshHome,
        ...extraEnv,
      },
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("hsh kubeconfig <connection> — happy path", () => {
  test("prints the ephemeral kubeconfig path on stdout", async () => {
    await withStubApi(
      {
        connections: [
          { id: "1", name: "prod-cluster", type: "kubernetes" },
        ],
        credentials: {
          "prod-cluster": {
            connection_credentials: {
              hostname: "gw.example.com",
              port: "8443",
              proxy_token: "tok-prod",
              command: "kubectl",
            },
          },
        },
      },
      async (apiUrl) => {
        plantAuth(apiUrl);
        const r = await runHsh(["kubeconfig", "prod-cluster"]);
        expect(r.code).toBe(0);

        const path = r.stdout.trim();
        // The path is JUST the path — no log lines, no decoration.
        expect(path).toBe(join(tmpHshHome, "kube", "prod-cluster.yaml"));
        expect(existsSync(path)).toBe(true);
        expect(statSync(path).mode & 0o777).toBe(0o600);

        // User-facing messages are on stderr, not stdout.
        expect(r.stderr).toContain("Kubeconfig ready for prod-cluster");
      },
    );
  });

  test("--merge prepends the hsh path to existing KUBECONFIG", async () => {
    await withStubApi(
      {
        connections: [{ id: "1", name: "prod-cluster", type: "kubernetes" }],
        credentials: {
          "prod-cluster": {
            connection_credentials: {
              hostname: "gw.example.com",
              port: "8443",
              proxy_token: "tok",
              command: "kubectl",
            },
          },
        },
      },
      async (apiUrl) => {
        plantAuth(apiUrl);
        const r = await runHsh(["kubeconfig", "--merge", "prod-cluster"], {
          KUBECONFIG: "/home/u/.kube/work-config",
        });
        expect(r.code).toBe(0);
        const out = r.stdout.trim();
        const expected = `${join(tmpHshHome, "kube", "prod-cluster.yaml")}:/home/u/.kube/work-config`;
        expect(out).toBe(expected);
      },
    );
  });
});

describe("hsh kubeconfig — error paths", () => {
  test("unknown connection name → exit 1, message on stderr, no stdout output", async () => {
    await withStubApi(
      {
        connections: [{ id: "1", name: "prod-cluster", type: "kubernetes" }],
        credentials: {},
      },
      async (apiUrl) => {
        plantAuth(apiUrl);
        const r = await runHsh(["kubeconfig", "nonexistent"]);
        expect(r.code).toBe(1);
        expect(r.stdout.trim()).toBe(""); // CRITICAL: nothing on stdout
        expect(r.stderr).toContain("No Kubernetes connection named 'nonexistent'");
      },
    );
  });

  test("review pending → exit 75 (EX_TEMPFAIL)", async () => {
    await withStubApi(
      {
        connections: [{ id: "1", name: "prod-cluster", type: "kubernetes" }],
        credentials: {
          "prod-cluster": {
            has_review: true,
            review_id: "rev-123",
            // no connection_credentials -> review pending
          },
        },
      },
      async (apiUrl) => {
        plantAuth(apiUrl);
        const r = await runHsh(["kubeconfig", "prod-cluster"]);
        expect(r.code).toBe(75);
        expect(r.stdout.trim()).toBe(""); // no path written
        expect(r.stderr).toContain("requires approval");
        expect(r.stderr).toContain("rev-123");
      },
    );
  });

  test("API unset → exit 1 with config error message", async () => {
    // Don't plant auth/config — api-url is missing.
    const r = await runHsh(["kubeconfig", "prod-cluster"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("API URL not configured");
    expect(r.stdout.trim()).toBe("");
  });
});

describe("hsh kubeconfig — fuzzy matching is OFF (exact name only)", () => {
  test("'prod' does NOT match connection 'production-cluster' (regression for ENG-351)", async () => {
    await withStubApi(
      {
        connections: [{ id: "1", name: "production-cluster", type: "kubernetes" }],
        credentials: {
          "production-cluster": {
            connection_credentials: {
              hostname: "gw.example.com",
              port: "8443",
              proxy_token: "t",
              command: "kubectl",
            },
          },
        },
      },
      async (apiUrl) => {
        plantAuth(apiUrl);
        const r = await runHsh(["kubeconfig", "prod"]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("No Kubernetes connection named 'prod'");
      },
    );
  });
});
