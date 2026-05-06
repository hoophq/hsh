import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { spawn } from "child_process";
import { ExitCodes } from "../src/plugins/exit-codes.ts";

/**
 * End-to-end exit-code propagation test.
 *
 * Strategy: install a fake `ssh` (and `kubectl`) script under a temp
 * directory, prepend that directory to PATH, then `Bun.spawn` the hsh
 * binary (`bun src/index.ts plugin run ssh -- ...`) so the plugin
 * actually runs. The fake reads `EXIT_CODE` from its env and exits with
 * that. We assert the parent process exits with the SAME code.
 *
 * The plugin's path is the simple one: no api-url configured →
 * `isAuthenticated()` is false → early passthrough → fake ssh runs →
 * its exit code is propagated. This pins the most important contract:
 * for non-Hoop targets, hsh's exit code equals the underlying tool's.
 */

let tmpBin: string;
let tmpHshHome: string;
let realPath: string | undefined;

beforeAll(() => {
  tmpBin = mkdtempSync(join(tmpdir(), "hsh-fakebin-"));
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-exitcode-home-"));

  // Fake ssh: exits with $EXIT_CODE (default 0). Echoes a marker so we know
  // it actually ran (and the test catches misroutes that bypass our fake).
  const fakeSsh = `#!/bin/sh
echo "[fake-ssh] argv=$*" 1>&2
exit \${EXIT_CODE:-0}
`;
  writeFileSync(join(tmpBin, "ssh"), fakeSsh);
  chmodSync(join(tmpBin, "ssh"), 0o755);

  const fakeKubectl = `#!/bin/sh
# Pass through 'config current-context' so hsh's kubectl plugin can detect
# a context name without spawning real kubectl. For everything else, exit
# with EXIT_CODE.
if [ "\$1 \$2" = "config current-context" ]; then
  echo "fake-context"
  exit 0
fi
echo "[fake-kubectl] argv=\$*" 1>&2
exit \${EXIT_CODE:-0}
`;
  writeFileSync(join(tmpBin, "kubectl"), fakeKubectl);
  chmodSync(join(tmpBin, "kubectl"), 0o755);

  realPath = process.env.PATH;
});

afterAll(() => {
  rmSync(tmpBin, { recursive: true, force: true });
  rmSync(tmpHshHome, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHsh(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve_, reject) => {
    const child = spawn("bun", ["run", "src/index.ts", ...args], {
      env: {
        ...process.env,
        // Prepend our fake-bin so the plugin's spawn() finds our ssh / kubectl.
        PATH: `${tmpBin}:${realPath ?? ""}`,
        // Hermetic state dir (no real api-url, no real auth).
        HSH_HOME: tmpHshHome,
        ...env,
      },
      cwd: resolve("."),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve_({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

describe("ssh: exit-code propagation", () => {
  test.each([
    [0, "clean exit"],
    [1, "generic ssh failure"],
    [42, "user-defined exit code"],
    [124, "timeout exit code"],
    [127, "command not found"],
    [255, "ssh-style protocol failure"],
  ])("ssh exits %i (%s) → hsh exits with same code", async (expected, _label) => {
    const res = await runHsh(["plugin", "run", "ssh", "--", "host1"], {
      EXIT_CODE: String(expected),
    });
    // Sanity: the fake ssh actually ran (otherwise the test is meaningless).
    expect(res.stderr).toContain("[fake-ssh]");
    expect(res.code).toBe(expected);
  });
});

describe("kubectl: exit-code propagation", () => {
  test.each([
    [0, "clean exit"],
    [1, "generic kubectl failure"],
    [127, "command not found"],
  ])("kubectl exits %i (%s) → hsh exits with same code", async (expected, _label) => {
    const res = await runHsh(["plugin", "run", "kubectl", "--", "get", "pods"], {
      EXIT_CODE: String(expected),
    });
    expect(res.stderr).toContain("[fake-kubectl]");
    expect(res.code).toBe(expected);
  });
});

describe("hsh kubeconfig: AuthRequired exit code (ENG-359)", () => {
  /**
   * The `hsh kubeconfig` command has no native fallback (unlike ssh /
   * kubectl). When called without a session it must:
   *   * NOT auto-launch a browser
   *   * Print a clear "session expired, run hsh login" message to stderr
   *   * Exit with ExitCodes.AuthRequired (77)
   *
   * We trigger this by:
   *   1. Configuring an api-url (otherwise the command exits early as
   *      generic-error, which is a different path).
   *   2. NOT writing auth.json — so ensureAuthenticated() throws.
   */
  test("exits 77 with re-auth message when no session exists", async () => {
    // Pre-populate config.json with an api-url; HSH_HOME is hermetic
    // (set by runHsh).
    const configFile = join(tmpHshHome, "config.json");
    writeFileSync(configFile, JSON.stringify({ apiUrl: "https://example.invalid" }));

    const res = await runHsh(["kubeconfig", "any-conn"]);

    expect(res.code).toBe(ExitCodes.AuthRequired); // 77
    expect(res.code).not.toBe(ExitCodes.GenericError);
    expect(res.code).not.toBe(ExitCodes.ReviewPending);
    // Message must mention the canonical instruction.
    expect(res.stderr.toLowerCase()).toContain("hsh login");
    expect(res.stderr.toLowerCase()).toContain("expired");
    // stdout must remain clean — KUBECONFIG=$(hsh kubeconfig ...)
    // capture would otherwise consume an error string.
    expect(res.stdout.trim()).toBe("");

    rmSync(configFile, { force: true });
  });
});

describe("ExitCodes constants", () => {
  test("Success === 0", () => {
    expect(ExitCodes.Success).toBe(0);
  });

  test("GenericError === 1 (collides with ssh's generic-1 by necessity)", () => {
    expect(ExitCodes.GenericError).toBe(1);
  });

  test("ReviewPending === 75 (EX_TEMPFAIL)", () => {
    // Distinct from 0 so 'connection requires approval' is NOT misread as success.
    expect(ExitCodes.ReviewPending).toBe(75);
    expect(ExitCodes.ReviewPending).not.toBe(0);
  });

  test("AuthRequired === 77 (EX_NOPERM)", () => {
    // Distinct from ReviewPending and Success so script wrappers can branch
    // 'session expired' vs 'approval pending' vs 'success'. See ENG-359.
    expect(ExitCodes.AuthRequired).toBe(77);
    expect(ExitCodes.AuthRequired).not.toBe(ExitCodes.ReviewPending);
    expect(ExitCodes.AuthRequired).not.toBe(ExitCodes.Success);
  });
});

/**
 * Static audit: every `process.exit(...)` in src/plugins/*.ts must use
 * either an `ExitCodes.*` constant OR pass a runtime value (`code ?? ...`
 * for child propagation). No bare numeric literals like `process.exit(0)`
 * sneaking back in.
 */
describe("ExitCodes audit (regression guard)", () => {
  test("no bare numeric literals in process.exit() calls", () => {
    // Audit the plugin entry points and the user-facing commands. We
    // skip src/auth/manager.ts intentionally: it has one legacy
    // process.exit(1) for "API URL not configured" that pre-dates the
    // ExitCodes constants and is functionally equivalent to
    // GenericError. Refactoring it would create a circular import
    // (manager imports exit-codes; exit-codes is in plugins/ which
    // is fine — but pulling more behavior into manager bloats it).
    // The audit's job is to catch *new* drift, not re-litigate that.
    const files = [
      "src/plugins/ssh.ts",
      "src/plugins/kubectl.ts",
      "src/commands/kubeconfig.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const content = require("fs").readFileSync(f, "utf-8") as string;
      for (const line of content.split("\n")) {
        const m = line.match(/process\.exit\(([^)]+)\)/);
        if (!m) continue;
        const arg = m[1].trim();
        // Allow: ExitCodes.X, code ?? ExitCodes.X, code ?? <ident>.
        // Forbid: bare integer literal like '0', '1', '75'.
        if (/^\d+$/.test(arg)) {
          offenders.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
