import { describe, expect, test } from "bun:test";
import { getPublicServerInfo } from "../src/api/serverinfo.ts";

/**
 * Wire-contract tests for `/api/publicserverinfo`. Source of truth:
 * hoophq/hoop `gateway/api/openapi/types.go::PublicServerInfo`.
 */

describe("getPublicServerInfo", () => {
  test("parses the canonical local-auth response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ auth_method: "local", setup_required: false });
      },
    });
    try {
      const info = await getPublicServerInfo(`http://127.0.0.1:${server.port}`);
      expect(info).toEqual({ authMethod: "local", setupRequired: false });
    } finally {
      server.stop();
    }
  });

  test("parses oidc + setup_required true", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ auth_method: "oidc", setup_required: true });
      },
    });
    try {
      const info = await getPublicServerInfo(`http://127.0.0.1:${server.port}`);
      expect(info).toEqual({ authMethod: "oidc", setupRequired: true });
    } finally {
      server.stop();
    }
  });

  test("tolerates missing setup_required field (defaults to false)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ auth_method: "saml" });
      },
    });
    try {
      const info = await getPublicServerInfo(`http://127.0.0.1:${server.port}`);
      expect(info).toEqual({ authMethod: "saml", setupRequired: false });
    } finally {
      server.stop();
    }
  });

  test("tolerates extra unknown fields without throwing", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          auth_method: "local",
          setup_required: false,
          server_version: "1.99.0",
          extra: { nested: true },
        });
      },
    });
    try {
      const info = await getPublicServerInfo(`http://127.0.0.1:${server.port}`);
      expect(info.authMethod).toBe("local");
    } finally {
      server.stop();
    }
  });

  test("treats missing auth_method as empty string (orchestrator handles 'unsupported')", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({});
      },
    });
    try {
      const info = await getPublicServerInfo(`http://127.0.0.1:${server.port}`);
      expect(info.authMethod).toBe("");
      expect(info.setupRequired).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("throws on non-2xx with the gateway's message", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ message: "internal config error" }, { status: 500 });
      },
    });
    try {
      await expect(
        getPublicServerInfo(`http://127.0.0.1:${server.port}`),
      ).rejects.toThrow(/internal config error/);
    } finally {
      server.stop();
    }
  });

  test("throws on malformed JSON body", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("not-json", {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      await expect(
        getPublicServerInfo(`http://127.0.0.1:${server.port}`),
      ).rejects.toThrow(/malformed/);
    } finally {
      server.stop();
    }
  });

  test("strips trailing slashes from apiUrl before joining the path", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname);
        return Response.json({ auth_method: "local", setup_required: false });
      },
    });
    try {
      await getPublicServerInfo(`http://127.0.0.1:${server.port}/`);
      expect(paths).toEqual(["/api/publicserverinfo"]);
    } finally {
      server.stop();
    }
  });
});
