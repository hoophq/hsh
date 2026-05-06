import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { debug, isDebugEnabled } from "../src/ui/log.ts";

/**
 * The HSH_DEBUG logger is gated entirely on `process.env.HSH_DEBUG`. Tests
 * mutate the env var to exercise both states; production code reads the var
 * lazily on every call so this works without re-importing.
 */

const realDebug = process.env.HSH_DEBUG;

beforeEach(() => {
  delete process.env.HSH_DEBUG;
});

afterEach(() => {
  if (realDebug !== undefined) {
    process.env.HSH_DEBUG = realDebug;
  } else {
    delete process.env.HSH_DEBUG;
  }
});

/**
 * Capture the next stderr write produced by `fn()`. We monkey-patch
 * `console.error` (which is what the logger writes through). Restored on
 * function exit even if `fn` throws.
 */
function captureStderr(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

describe("isDebugEnabled", () => {
  test("returns false when HSH_DEBUG is unset", () => {
    expect(isDebugEnabled()).toBe(false);
  });

  test("returns false for empty string", () => {
    process.env.HSH_DEBUG = "";
    expect(isDebugEnabled()).toBe(false);
  });

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["yes", true],
    ["YES", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["nope", false],
  ])("HSH_DEBUG=%p → %p", (value, expected) => {
    process.env.HSH_DEBUG = value;
    expect(isDebugEnabled()).toBe(expected);
  });
});

describe("debug()", () => {
  test("emits nothing when HSH_DEBUG is unset", () => {
    const lines = captureStderr(() => debug("comp", "message"));
    expect(lines).toEqual([]);
  });

  test("writes one stderr line when HSH_DEBUG=1", () => {
    process.env.HSH_DEBUG = "1";
    const lines = captureStderr(() => debug("comp", "hello"));
    expect(lines.length).toBe(1);
    // Format: "[hsh debug] comp: hello" (with chalk gray on the prefix)
    expect(lines[0]).toContain("[hsh debug]");
    expect(lines[0]).toContain("comp:");
    expect(lines[0]).toContain("hello");
  });

  test("appends extra string/number/boolean args space-separated", () => {
    process.env.HSH_DEBUG = "1";
    const lines = captureStderr(() => debug("c", "msg", "extra1", 42, true));
    expect(lines[0]).toContain("msg extra1 42 true");
  });

  test("JSON-stringifies object args", () => {
    process.env.HSH_DEBUG = "1";
    const lines = captureStderr(() =>
      debug("c", "obj", { a: 1, b: "two" })
    );
    expect(lines[0]).toContain('{"a":1,"b":"two"}');
  });

  test("emits null/undefined as literal strings", () => {
    process.env.HSH_DEBUG = "1";
    const lines = captureStderr(() => debug("c", "x", null, undefined));
    expect(lines[0]).toContain("null");
    expect(lines[0]).toContain("undefined");
  });

  test("turning off mid-process suppresses subsequent calls", () => {
    process.env.HSH_DEBUG = "1";
    const onLines = captureStderr(() => debug("c", "first"));
    expect(onLines.length).toBe(1);

    delete process.env.HSH_DEBUG;
    const offLines = captureStderr(() => debug("c", "second"));
    expect(offLines.length).toBe(0);
  });
});

describe("debug() leak audit (regression guard)", () => {
  test("none of the wired call sites pass token/password/refresh to debug()", async () => {
    // Walk every src/*.ts file, grep for `debug(`, and assert the rest of
    // the line doesn't contain a known-bad identifier. Static, source-level
    // check — catches regressions where someone accidentally wires
    // `debug("auth", `token=${token}`)` or similar.
    const { readdirSync, readFileSync, statSync } = await import("fs");
    const { join } = await import("path");

    const BAD = [
      // eslint-disable-next-line — these are the exact substrings we forbid
      /\btoken\s*[:=]\s*\$?\{?\s*token/i,
      /password\s*[:=]\s*\$?\{?\s*[a-z]/i,
      /proxy_token\b/i,
      /refresh_token\b/i,
      /creds\.password/i,
      /creds\.proxy_token/i,
    ];

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          out.push(...walk(p));
        } else if (entry.endsWith(".ts")) {
          out.push(p);
        }
      }
      return out;
    }

    const files = walk("src");
    const offenders: string[] = [];
    for (const f of files) {
      // Skip the logger module — its docstring intentionally mentions the words.
      if (f.endsWith("ui/log.ts")) continue;
      const content = readFileSync(f, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.includes("debug(")) continue;
        for (const re of BAD) {
          if (re.test(line)) {
            offenders.push(`${f}: ${line.trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
