import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";

/**
 * Real-shell integration tests for `hsh shell-init`.
 *
 * Strategy: build a tiny `hsh` shim that delegates to `bun run src/index.ts`
 * (so we don't need to actually compile the binary), put it in a known
 * directory, then drive `tests/shell/scenarios.sh` (or .fish) under bash,
 * zsh, and dash (POSIX `sh`). Each scenario asserts one specific shell
 * behavior. Skips a shell if the interpreter isn't on PATH.
 *
 * Mirrors the matrix in `docs/testing/shells.md`.
 */

interface ShellInfo {
  name: "bash" | "zsh" | "dash" | "sh" | "fish";
  bin: string;
  /** Which scenario script to invoke. */
  script: "scenarios.sh" | "scenarios.fish";
}

function whichSync(cmd: string): string | null {
  const r = spawnSync("which", [cmd], { encoding: "utf-8" });
  if (r.status === 0) return r.stdout.trim();
  return null;
}

function discoverShells(): ShellInfo[] {
  const out: ShellInfo[] = [];
  const bash = whichSync("bash");
  if (bash) out.push({ name: "bash", bin: bash, script: "scenarios.sh" });
  const zsh = whichSync("zsh");
  if (zsh) out.push({ name: "zsh", bin: zsh, script: "scenarios.sh" });
  // Prefer dash (true POSIX sh on Linux); fall back to /bin/sh.
  const dash = whichSync("dash") ?? whichSync("ash");
  if (dash) out.push({ name: "dash", bin: dash, script: "scenarios.sh" });
  // Fall back to /bin/sh if no dash/ash present (covers macOS, where sh is bash 3.2).
  if (!dash) {
    const sh = whichSync("sh");
    if (sh) out.push({ name: "sh", bin: sh, script: "scenarios.sh" });
  }
  const fish = whichSync("fish");
  if (fish) out.push({ name: "fish", bin: fish, script: "scenarios.fish" });
  return out;
}

const SHELLS = discoverShells();
const POSIX_SCENARIOS = [
  "defines_ssh_function",
  "defines_kubectl_function",
  "function_routes_through_hsh",
  "command_bypass_skips_hsh",
  "exit_code_propagates",
  "exit_code_in_conditionals",
  "subshell_inherits_function",
  "pipe_works",
  "git_ssh_command_export",
  "rsync_rsh_export",
] as const;

const FISH_SCENARIOS = [
  "defines_ssh_function",
  "defines_kubectl_function",
  "function_routes_through_hsh",
  "command_bypass_skips_hsh",
  "exit_code_propagates",
  "git_ssh_command_export",
  "rsync_rsh_export",
] as const;

let realBinDir: string;

beforeAll(() => {
  // The shim has to be a self-contained binary the shell can invoke as
  // `hsh`. We can't `bun build --compile` here without slowing the test
  // suite massively, so we make a tiny shell script that forwards to
  // `bun run src/index.ts`. The shells under test see it as a normal
  // executable on PATH.
  realBinDir = mkdtempSync(join(tmpdir(), "hsh-realbin-"));
  const repo = resolve(".");
  // Stay on the user's PATH (so bun is findable), don't recurse into our
  // own shim. The script invokes bun directly.
  const shim = `#!/bin/sh
exec bun run "${repo}/src/index.ts" "$@"
`;
  writeFileSync(join(realBinDir, "hsh"), shim);
  chmodSync(join(realBinDir, "hsh"), 0o755);
});

afterAll(() => {
  rmSync(realBinDir, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScenario(shell: ShellInfo, scenario: string): RunResult {
  const tmpDir = mkdtempSync(join(tmpdir(), `hsh-shell-${shell.name}-`));
  try {
    const scriptPath = resolve("tests/shell", shell.script);
    const r = spawnSync(shell.bin, [scriptPath], {
      env: {
        ...process.env,
        TMP_DIR: tmpDir,
        REAL_BIN_DIR: realBinDir,
        SCENARIO: scenario,
        // Strip any pre-existing GIT_SSH_COMMAND/RSYNC_RSH so the export
        // tests measure what shell-init sets, not what the runner inherited.
        GIT_SSH_COMMAND: "",
        RSYNC_RSH: "",
      },
      encoding: "utf-8",
      // Be defensive: the test should never need more than 30s.
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (SHELLS.length === 0) {
  describe.skip("Shell integration: no compatible shell on PATH", () => {
    test("skipped", () => {
      // No-op
    });
  });
} else {
  for (const shell of SHELLS) {
    const scenarios = shell.name === "fish" ? FISH_SCENARIOS : POSIX_SCENARIOS;
    describe(`shell-init in ${shell.name} (${shell.bin})`, () => {
      for (const scenario of scenarios) {
        test(scenario, () => {
          const r = runScenario(shell, scenario);
          // Compose a readable failure message that includes EVERYTHING
          // we need to debug a flaky CI run.
          const detail = `\n  status: ${r.status}\n  stdout: ${r.stdout.trim()}\n  stderr: ${r.stderr.trim()}`;
          expect(r.status, `non-zero exit${detail}`).toBe(0);
          expect(r.stdout, `expected RESULT: ok${detail}`).toContain("RESULT: ok");
        });
      }
    });
  }
}
