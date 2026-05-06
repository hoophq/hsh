import { describe, expect, test } from "bun:test";

/**
 * Sentinel test — verifies the bun test runner is wired up and TypeScript
 * imports resolve. Real-source tests (with proper test seams) land alongside
 * the feature work that introduces them; this file just proves the harness.
 */

describe("sentinel: bun test runner is wired up", () => {
  test("basic assertion works", () => {
    expect(1 + 1).toBe(2);
  });

  test("typescript types are checked at runtime via Bun", () => {
    const sample: { name: string; count: number } = { name: "hsh", count: 1 };
    expect(sample.name).toBe("hsh");
    expect(sample.count).toBeGreaterThan(0);
  });

  test("async/await works", async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });
});
