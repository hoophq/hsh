/**
 * tests/login-command-options.test.ts — regression guard for a
 * commander.js footgun that silently disabled the daemon login leg.
 *
 * `--no-tunnel` is a *negatable* boolean option: commander derives a
 * `tunnel` attribute that defaults to TRUE and is flipped to FALSE when
 * the flag is passed. Passing an explicit `false` as the option's
 * default value OVERRIDES that auto-default, pinning `tunnel` to false
 * always — so `hsh login`'s `if (opts.tunnel)` block never ran and the
 * daemon was never re-authenticated (no output, no warning).
 *
 * These tests assert the *parsed defaults* of the real command objects,
 * so a future re-introduction of a `false` default arg fails here rather
 * than silently in the field. We inspect commander's option metadata
 * directly (no .action execution — the actions do real auth I/O).
 */

import { describe, expect, test } from "bun:test";
import type { Command } from "commander";

import { loginCommand } from "../src/commands/login.ts";
import { logoutCommand } from "../src/commands/logout.ts";
import { tunnelCommand } from "../src/commands/tunnel.ts";

/**
 * Resolve the effective default for a negatable boolean attribute by
 * reading commander's registered option metadata. For a `--no-x` flag
 * with no explicit default, commander reports defaultValue === undefined
 * and the runtime default is `true`; an explicit `false` default shows
 * up as defaultValue === false (the bug).
 */
function negatableDefault(cmd: Command, attr: string): boolean {
  const opt = cmd.options.find((o) => o.attributeName() === attr);
  if (!opt) throw new Error(`option ${attr} not found on ${cmd.name()}`);
  // commander: a negatable flag with no explicit default → undefined →
  // effective runtime default true. An explicit false default is the bug.
  return opt.defaultValue === undefined ? true : opt.defaultValue;
}

describe("negatable --no-* options default to true (daemon leg enabled)", () => {
  test("hsh login --no-tunnel defaults tunnel=true", () => {
    expect(negatableDefault(loginCommand, "tunnel")).toBe(true);
  });

  test("hsh login --no-browser defaults browser=true", () => {
    expect(negatableDefault(loginCommand, "browser")).toBe(true);
  });

  test("hsh login --no-setup defaults setup=true", () => {
    expect(negatableDefault(loginCommand, "setup")).toBe(true);
  });

  test("hsh logout --no-tunnel defaults tunnel=true", () => {
    expect(negatableDefault(logoutCommand, "tunnel")).toBe(true);
  });

  test("hsh tunnel login --no-browser defaults browser=true", () => {
    const loginSub = tunnelCommand.commands.find((c) => c.name() === "login");
    if (!loginSub) throw new Error("tunnel login subcommand not found");
    expect(negatableDefault(loginSub, "browser")).toBe(true);
  });
});
