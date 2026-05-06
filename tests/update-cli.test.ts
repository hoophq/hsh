import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

/**
 * `hsh update --check` end-to-end against a stubbed GitHub API.
 *
 * Strategy: spin up a Bun.serve that responds to /repos/hoophq/hsh/releases/latest,
 * point HSH_GITHUB_API at it, run the real binary via 'bun run src/index.ts',
 * and assert exit code + stderr/stdout content for the three states:
 *   - new version available
 *   - already up-to-date
 *   - GitHub unreachable
 */

let tmpHshHome: string;
const realHshHome = process.env.HSH_HOME;

beforeEach(() => {
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-update-cli-"));
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

async function withStubGitHub<T>(
  reply: { tag: string; prerelease?: boolean; body?: string },
  fn: (apiBase: string) => Promise<T>,
): Promise<T> {
  // Two-pass dance: bind to port 0 first to learn the port, then we can
  // reference it inside the fetch handler when synthesising asset URLs.
  // (TypeScript trips on self-referential closures otherwise.)
  let port = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/repos/hoophq/hsh/releases/latest") {
        return Response.json({
          tag_name: reply.tag,
          name: reply.tag,
          body: reply.body ?? null,
          prerelease: reply.prerelease ?? false,
          draft: false,
          html_url: `https://github.com/hoophq/hsh/releases/tag/${reply.tag}`,
          assets: [
            {
              name: "hsh-linux-x64",
              browser_download_url: `http://127.0.0.1:${port}/dl/hsh-linux-x64`,
              size: 1234,
            },
            {
              name: "hsh-darwin-arm64",
              browser_download_url: `http://127.0.0.1:${port}/dl/hsh-darwin-arm64`,
              size: 1234,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  if (typeof server.port !== "number") {
    throw new Error("Bun.serve did not return a numeric port");
  }
  port = server.port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.stop();
  }
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

describe("hsh update --check", () => {
  test("reports newer version available, exits 0, doesn't download", async () => {
    await withStubGitHub({ tag: "v99.0.0" }, async (apiBase) => {
      const r = await runHsh(["update", "--check"], { HSH_GITHUB_API: apiBase });
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain("Update available");
      expect(out).toContain("v99.0.0");
      // --check must NOT enter the confirmation/download path.
      expect(out).not.toContain("Proceed with upgrade");
      expect(out).not.toContain("Downloading");
    });
  });

  test("reports up-to-date when GitHub returns the same version", async () => {
    await withStubGitHub({ tag: "v0.1.0" }, async (apiBase) => {
      const r = await runHsh(["update", "--check"], { HSH_GITHUB_API: apiBase });
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain("already on the latest");
    });
  });

  test("reports up-to-date when GitHub returns an OLDER version", async () => {
    // Should never happen in practice, but the compare is symmetric.
    await withStubGitHub({ tag: "v0.0.1" }, async (apiBase) => {
      const r = await runHsh(["update", "--check"], { HSH_GITHUB_API: apiBase });
      expect(r.code).toBe(0);
      const out = r.stdout + r.stderr;
      expect(out).toContain("already on the latest");
    });
  });

  test("GitHub unreachable → exit 1 with clear error", async () => {
    // Point at a closed loopback port — fail-fast.
    const r = await runHsh(["update", "--check"], {
      HSH_GITHUB_API: "http://127.0.0.1:1",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Could not reach GitHub Releases");
  });

  test("HSH_UPDATE_CHANNEL=prerelease is reported in the output", async () => {
    await withStubGitHub({ tag: "v0.1.0" }, async (apiBase) => {
      const r = await runHsh(["update", "--check"], {
        HSH_GITHUB_API: apiBase,
        HSH_UPDATE_CHANNEL: "prerelease",
      });
      const out = r.stdout + r.stderr;
      expect(out).toContain("Channel: prerelease");
    });
  });
});

describe("hsh update (interactive prompt)", () => {
  test("non-TTY stdin treats prompt as 'no' (does NOT download)", async () => {
    // Without --yes and without a TTY, our readLine() returns "" → no.
    await withStubGitHub({ tag: "v99.0.0" }, async (apiBase) => {
      const r = await runHsh(["update"], { HSH_GITHUB_API: apiBase });
      // We did detect an update; we did NOT download (stub has no /dl endpoint
      // that returns the right binary, and the abort path exits 0).
      const out = r.stdout + r.stderr;
      expect(out).toContain("Update available");
      expect(out).toContain("Aborted.");
      expect(r.code).toBe(0);
    });
  });
});

describe("hsh status: cached update check", () => {
  test("after a successful --check, status surfaces 'Update available'", async () => {
    await withStubGitHub({ tag: "v99.0.0" }, async (apiBase) => {
      // Prime the cache by running --check first.
      const c = await runHsh(["update", "--check"], { HSH_GITHUB_API: apiBase });
      expect(c.code).toBe(0);

      // status should pick up the cached availability without re-fetching.
      // We deliberately point HSH_GITHUB_API at a closed port to prove the
      // cache is being used (status would fail otherwise).
      const s = await runHsh(["status"], {
        HSH_GITHUB_API: "http://127.0.0.1:1",
      });
      const out = s.stdout + s.stderr;
      expect(out).toContain("Update available");
      expect(out).toContain("v99.0.0");
    });
  });

  test("status without a cached check does NOT block on a slow GitHub API", async () => {
    // Cache empty + GitHub closed → checkForUpdate returns null gracefully.
    // This used to be a hang; the test pins that it isn't.
    const start = Date.now();
    const s = await runHsh(["status"], { HSH_GITHUB_API: "http://127.0.0.1:1" });
    const elapsed = Date.now() - start;
    expect(s.code).toBe(0);
    // Even without a cache, status should return within ~10s (the GitHub
    // releases timeout). In practice it's much faster (loopback reject).
    expect(elapsed).toBeLessThan(10_000);
  });
});
