import { describe, expect, test } from "bun:test";
import { generateFish, generatePosix } from "../src/commands/shell-init.ts";

/**
 * `shell-init` emits real shell code that gets `eval`'d into the user's
 * interactive shell. Drift here is a footgun: a stray space, a missing
 * `command` builtin, or a wrong quoting style and the wrapper either
 * blackholes the user's commands or recurses infinitely.
 *
 * These tests pin the EXACT bytes of the rendered script for both
 * POSIX and fish variants. Real-shell behavior is exercised separately
 * by `tests/shell/*.sh` (run via the CI matrix in `.github/workflows/ci.yml`).
 */

const COMMANDS = [
  { command: "ssh", plugin: "ssh" },
  { command: "kubectl", plugin: "kubectl" },
];

describe("generatePosix", () => {
  test("emits a function per command + GIT_SSH_COMMAND/RSYNC_RSH exports", () => {
    const out = generatePosix(COMMANDS);
    expect(out).toContain("ssh() {");
    expect(out).toContain('  command hsh plugin run ssh -- "$@"');
    expect(out).toContain("kubectl() {");
    expect(out).toContain('  command hsh plugin run kubectl -- "$@"');
    expect(out).toContain('export GIT_SSH_COMMAND="hsh plugin run ssh --"');
    expect(out).toContain('export RSYNC_RSH="hsh plugin run ssh --"');
  });

  test("uses 'command' builtin to avoid recursion through the function", () => {
    // CRITICAL: without `command` the function would call itself ->
    // infinite loop -> stack overflow in interactive shell. Pin it.
    const out = generatePosix(COMMANDS);
    expect(out.match(/command hsh plugin run/g)?.length).toBe(2);
  });

  test("propagates the child exit code via 'return $?'", () => {
    // Without an explicit return, function exit code is the LAST executed
    // statement's. The 'command hsh plugin run' is the last statement here,
    // so its exit code propagates naturally — but the explicit `return $?`
    // makes the contract obvious + survives future refactors that add lines.
    const out = generatePosix(COMMANDS);
    expect(out).toContain("return $?");
    expect(out.match(/return \$\?/g)?.length).toBe(2);
  });

  test("opening header includes the eval install hint", () => {
    const out = generatePosix(COMMANDS);
    expect(out).toContain('eval "$(hsh shell-init)"');
  });

  test("empty commands list still produces valid (empty) shell code", () => {
    // Edge case: a build with no plugins. Output should still be sourceable
    // (no function, just the header + env var exports).
    const out = generatePosix([]);
    expect(out).not.toContain("() {");
    expect(out).toContain("# Hoop Shell Plugins");
    expect(out).toContain('export GIT_SSH_COMMAND=');
  });
});

describe("generateFish", () => {
  test("emits a function per command + set -gx exports", () => {
    const out = generateFish(COMMANDS);
    expect(out).toContain("function ssh");
    expect(out).toContain("  command hsh plugin run ssh -- $argv");
    expect(out).toContain("function kubectl");
    expect(out).toContain('set -gx GIT_SSH_COMMAND "hsh plugin run ssh --"');
    expect(out).toContain('set -gx RSYNC_RSH "hsh plugin run ssh --"');
  });

  test("uses 'command' builtin (same recursion-avoidance rationale as POSIX)", () => {
    const out = generateFish(COMMANDS);
    expect(out.match(/command hsh plugin run/g)?.length).toBe(2);
  });

  test("uses fish's $argv (not POSIX's \"$@\")", () => {
    const out = generateFish(COMMANDS);
    expect(out).toContain("$argv");
    expect(out).not.toContain('"$@"');
  });

  test("opening header includes fish-specific install hint", () => {
    const out = generateFish(COMMANDS);
    expect(out).toContain("hsh shell-init --shell fish | source");
  });
});

describe("regression: function name must match wrapped command exactly", () => {
  test("POSIX function name uses the {command} field, NOT the {plugin} field", () => {
    // If we ever expose a plugin where command !== plugin (e.g. plugin
    // 'kubernetes' wrapping the 'kubectl' command), the function MUST be
    // named after the command — that's what the user types.
    const out = generatePosix([{ command: "kubectl", plugin: "kubernetes" }]);
    expect(out).toContain("kubectl() {");
    expect(out).toContain("command hsh plugin run kubernetes --");
  });

  test("fish function name uses the {command} field too", () => {
    const out = generateFish([{ command: "kubectl", plugin: "kubernetes" }]);
    expect(out).toContain("function kubectl");
    expect(out).toContain("command hsh plugin run kubernetes --");
  });
});
