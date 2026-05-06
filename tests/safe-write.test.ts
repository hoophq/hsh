import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { safeWrite, safeWriteJson } from "../src/util/safe-write.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hsh-safewrite-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("safeWrite", () => {
  test("writes file content with default mode 0600", () => {
    const path = join(dir, "f.txt");
    safeWrite(path, "hello");
    expect(readFileSync(path, "utf-8")).toBe("hello");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("respects custom mode", () => {
    const path = join(dir, "f.txt");
    safeWrite(path, "hello", { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test("accepts Buffer content", () => {
    const path = join(dir, "f.bin");
    safeWrite(path, Buffer.from([0x01, 0x02, 0x03]));
    const buf = readFileSync(path);
    expect(buf.length).toBe(3);
    expect(buf[0]).toBe(0x01);
    expect(buf[2]).toBe(0x03);
  });

  test("overwrites existing file atomically", () => {
    const path = join(dir, "f.txt");
    writeFileSync(path, "old content", { mode: 0o600 });
    safeWrite(path, "new content");
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });

  test("does not leave temp files behind on success", () => {
    const path = join(dir, "f.txt");
    safeWrite(path, "x");
    safeWrite(path, "y");
    safeWrite(path, "z");
    const remaining = readdirSync(dir);
    expect(remaining).toEqual(["f.txt"]);
  });

  test("preserves mode 0600 on overwrite even if old file had a different mode", () => {
    const path = join(dir, "f.txt");
    writeFileSync(path, "x", { mode: 0o644 });
    safeWrite(path, "y"); // default 0o600
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("safeWriteJson", () => {
  test("writes pretty-printed JSON with trailing newline", () => {
    const path = join(dir, "data.json");
    safeWriteJson(path, { a: 1, b: "two" });
    const content = readFileSync(path, "utf-8");
    expect(content).toBe('{\n  "a": 1,\n  "b": "two"\n}\n');
  });

  test("uses mode 0600 by default", () => {
    const path = join(dir, "data.json");
    safeWriteJson(path, { a: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

/**
 * Concurrency test: spawn N child Bun processes that each call
 * `safeWriteJson` on the same path with their own pid in the payload. After
 * they all exit, the file must contain ONE complete JSON document — i.e.
 * the bytes must match exactly one of the writers' payloads (no torn
 * write).
 *
 * The previous `writeFileSync` could leave half-written content; this test
 * fails on that buggy behavior.
 */
describe("safeWriteJson under concurrent writers", () => {
  test("file always contains exactly one complete writer's payload", async () => {
    const target = join(dir, "race.json");
    // Use the source file's path so the spawned bun script can import it
    // without a build step.
    const helperSrc = `
import { safeWriteJson } from "${process.cwd()}/src/util/safe-write.ts";
const path = process.argv[2];
const pid = Number(process.argv[3]);
// Pad payload so torn writes are easier to detect.
const payload = { pid, blob: "x".repeat(8192) };
for (let i = 0; i < 50; i++) {
  safeWriteJson(path, payload);
}
`;
    const helperPath = join(dir, "writer.ts");
    writeFileSync(helperPath, helperSrc);

    const N = 8;
    const procs = Array.from({ length: N }, (_, i) =>
      runProc("bun", [helperPath, target, String(1000 + i)])
    );
    const codes = await Promise.all(procs);
    expect(codes).toEqual(Array(N).fill(0));

    // After every writer is done the file must be parseable JSON whose
    // pid is one of the writers'. With non-atomic writes this would
    // sometimes throw `SyntaxError`.
    const raw = readFileSync(target, "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed.pid).toBe("number");
    expect(parsed.pid).toBeGreaterThanOrEqual(1000);
    expect(parsed.pid).toBeLessThan(1000 + N);
    expect(parsed.blob.length).toBe(8192);

    // No leftover temp files in the directory either.
    const tmps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmps).toEqual([]);
  });
});

function runProc(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => {
      if (code === 0) resolve(0);
      else reject(new Error(`exit=${code} stderr=${stderr}`));
    });
    child.on("error", reject);
  });
}
