import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { downloadAndInstall, sha256File } from "../src/update/install.ts";

/**
 * `downloadAndInstall` is the bit that's most important to lock down —
 * it touches the filesystem, hashes the download, and replaces the
 * running binary atomically. We spin up a Bun.serve to stand in for the
 * GitHub asset CDN.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "hsh-update-int-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Stub {
  port: number;
  stop: () => void;
}

function serveBytes(bytes: Uint8Array, opts: { status?: number } = {}): Stub {
  // Copy into a fresh ArrayBuffer-backed Uint8Array — the input may be
  // backed by SharedArrayBuffer in some Bun configurations, which the
  // Response/Blob types don't accept.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const server = Bun.serve({
    port: 0,
    fetch() {
      const status = opts.status ?? 200;
      const body: BodyInit | null =
        opts.status === undefined ? new Blob([owned]) : null;
      return new Response(body, { status });
    },
  });
  const port = server.port;
  if (typeof port !== "number") {
    throw new Error("Bun.serve did not return a numeric port");
  }
  return { port, stop: () => server.stop() };
}

function hashOf(data: Uint8Array): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

describe("downloadAndInstall: happy path", () => {
  test("downloads, verifies SHA256, and writes the binary at binPath with mode 0755", async () => {
    const payload = new TextEncoder().encode("fake-binary-content-for-test");
    const expected = hashOf(payload);
    const binPath = join(tmpDir, "hsh");
    const stub = serveBytes(payload);

    try {
      const result = await downloadAndInstall({
        url: `http://127.0.0.1:${stub.port}/asset`,
        expectedSha256: expected,
        binPath,
      });
      expect(result.bytesWritten).toBe(payload.length);
      expect(result.computedSha256).toBe(expected);
      expect(result.verified).toBe(true);

      // File exists with the downloaded content + executable mode (POSIX).
      expect(existsSync(binPath)).toBe(true);
      expect(readFileSync(binPath)).toEqual(Buffer.from(payload));
      if (process.platform !== "win32") {
        expect(statSync(binPath).mode & 0o777).toBe(0o755);
      }
      // Hash on disk matches.
      expect(sha256File(binPath)).toBe(expected);
    } finally {
      stub.stop();
    }
  });

  test("succeeds without verification when expectedSha256 is null", async () => {
    const payload = new TextEncoder().encode("unverified-content");
    const binPath = join(tmpDir, "hsh");
    const stub = serveBytes(payload);
    try {
      const result = await downloadAndInstall({
        url: `http://127.0.0.1:${stub.port}/asset`,
        expectedSha256: null,
        binPath,
      });
      expect(result.verified).toBe(false);
      expect(result.computedSha256).toBe(hashOf(payload));
      expect(existsSync(binPath)).toBe(true);
    } finally {
      stub.stop();
    }
  });

  test("overwrites an existing binary atomically (old content replaced)", async () => {
    const binPath = join(tmpDir, "hsh");
    writeFileSync(binPath, "OLD CONTENT", { mode: 0o755 });

    const payload = new TextEncoder().encode("NEW CONTENT");
    const stub = serveBytes(payload);
    try {
      await downloadAndInstall({
        url: `http://127.0.0.1:${stub.port}/asset`,
        expectedSha256: hashOf(payload),
        binPath,
      });
      expect(readFileSync(binPath, "utf-8")).toBe("NEW CONTENT");
    } finally {
      stub.stop();
    }
  });

  test("does not leave .partial temp files behind on success", async () => {
    const binPath = join(tmpDir, "hsh");
    const payload = new TextEncoder().encode("clean-content");
    const stub = serveBytes(payload);
    try {
      await downloadAndInstall({
        url: `http://127.0.0.1:${stub.port}/asset`,
        expectedSha256: null,
        binPath,
      });
    } finally {
      stub.stop();
    }
    const leftover = require("fs")
      .readdirSync(tmpDir)
      .filter((f: string) => f.includes(".partial"));
    expect(leftover).toEqual([]);
  });
});

describe("downloadAndInstall: error paths", () => {
  test("SHA256 mismatch → throws, leaves NO file at binPath, no .partial leak", async () => {
    const payload = new TextEncoder().encode("real-content");
    const wrongSha = "0".repeat(64);
    const binPath = join(tmpDir, "hsh");
    const stub = serveBytes(payload);
    try {
      let caught: unknown;
      try {
        await downloadAndInstall({
          url: `http://127.0.0.1:${stub.port}/asset`,
          expectedSha256: wrongSha,
          binPath,
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("SHA256 mismatch");
      // CRITICAL: the existing binary must not be replaced and the partial
      // download must not be left behind.
      expect(existsSync(binPath)).toBe(false);
      const partials = require("fs")
        .readdirSync(tmpDir)
        .filter((f: string) => f.includes(".partial"));
      expect(partials).toEqual([]);
    } finally {
      stub.stop();
    }
  });

  test("SHA256 mismatch when an old binary exists → keeps the old binary intact", async () => {
    const binPath = join(tmpDir, "hsh");
    writeFileSync(binPath, "OLD-BUT-WORKING", { mode: 0o755 });

    const payload = new TextEncoder().encode("tampered-content");
    const wrongSha = "f".repeat(64);
    const stub = serveBytes(payload);
    try {
      let threw = false;
      try {
        await downloadAndInstall({
          url: `http://127.0.0.1:${stub.port}/asset`,
          expectedSha256: wrongSha,
          binPath,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Old binary still in place, byte-identical.
      expect(readFileSync(binPath, "utf-8")).toBe("OLD-BUT-WORKING");
    } finally {
      stub.stop();
    }
  });

  test("HTTP 404 → throws ApiUnreachableError-shaped error", async () => {
    const stub = serveBytes(new Uint8Array(), { status: 404 });
    const binPath = join(tmpDir, "hsh");
    try {
      let threw = false;
      try {
        await downloadAndInstall({
          url: `http://127.0.0.1:${stub.port}/asset`,
          expectedSha256: null,
          binPath,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(existsSync(binPath)).toBe(false);
    } finally {
      stub.stop();
    }
  });
});
