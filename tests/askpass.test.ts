import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  buildAskpassEnv,
  cleanupAskpassPair,
  isAskpassEnabled,
  isVersionSupported,
  parseSshVersion,
  sweepOrphanAskpass,
  withAskpassEnv,
  writeAskpassPair,
} from "../src/auth/askpass.ts";

/**
 * Each test gets its own temp HSH_HOME so the suite never touches the real
 * `~/.hsh`. `HSH_HOME` is the supported override — see `src/config/store.ts`.
 */
const realHshHome = process.env.HSH_HOME;
const realFlag = process.env.HSH_SSH_ASKPASS;
const realDisplay = process.env.DISPLAY;
let tmpHshHome: string;

beforeEach(() => {
  tmpHshHome = mkdtempSync(join(tmpdir(), "hsh-askpass-test-"));
  process.env.HSH_HOME = tmpHshHome;
});

afterEach(() => {
  // Restore env we may have mutated.
  if (realHshHome !== undefined) process.env.HSH_HOME = realHshHome;
  else delete process.env.HSH_HOME;
  if (realFlag !== undefined) process.env.HSH_SSH_ASKPASS = realFlag;
  else delete process.env.HSH_SSH_ASKPASS;
  if (realDisplay !== undefined) process.env.DISPLAY = realDisplay;
  else delete process.env.DISPLAY;
  rmSync(tmpHshHome, { recursive: true, force: true });
});

describe("writeAskpassPair", () => {
  test("writes both files into ~/.hsh/askpass/ with correct modes", () => {
    const pair = writeAskpassPair("super-secret-token");

    expect(existsSync(pair.tokenPath)).toBe(true);
    expect(existsSync(pair.shimPath)).toBe(true);

    // Both files must be in the expected directory.
    expect(pair.tokenPath.startsWith(join(tmpHshHome, "askpass") + "/")).toBe(true);
    expect(pair.shimPath.startsWith(join(tmpHshHome, "askpass") + "/")).toBe(true);

    // Token file: 0600 (credential, never group/world readable).
    expect(statSync(pair.tokenPath).mode & 0o777).toBe(0o600);
    // Shim: 0700 (must be exec'able by owner).
    expect(statSync(pair.shimPath).mode & 0o777).toBe(0o700);
  });

  test("token file holds the raw token verbatim (no trailing newline)", () => {
    // OpenSSH treats a trailing \n as part of the password on some
    // versions. Don't add one. Pin this in the regression test.
    const pair = writeAskpassPair("abcDEF.123");
    const content = readFileSync(pair.tokenPath, "utf-8");
    expect(content).toBe("abcDEF.123");
    expect(content.endsWith("\n")).toBe(false);
  });

  test("shim is a /bin/sh script that cats the token file", () => {
    const pair = writeAskpassPair("tok-123");
    const shim = readFileSync(pair.shimPath, "utf-8");

    expect(shim.startsWith("#!/bin/sh")).toBe(true);
    expect(shim).toContain("umask 077");
    // Must reference the token file by absolute, single-quoted path.
    expect(shim).toContain(`cat '${pair.tokenPath}'`);
    // Must NOT contain the token itself (whole point: token isn't in
    // env/argv/cmdline of the shim, only in the 0600 file).
    expect(shim).not.toContain("tok-123");
  });

  test("two concurrent writes get distinct paths (no race / collision)", () => {
    const a = writeAskpassPair("a");
    const b = writeAskpassPair("b");
    expect(a.tokenPath).not.toBe(b.tokenPath);
    expect(a.shimPath).not.toBe(b.shimPath);
    expect(readFileSync(a.tokenPath, "utf-8")).toBe("a");
    expect(readFileSync(b.tokenPath, "utf-8")).toBe("b");
  });

  test("filename includes pid for forensic attribution", () => {
    const pair = writeAskpassPair("x");
    // pid prefix lets ops grep `ls ~/.hsh/askpass/ | awk -F- '{print $1}'`
    // to identify the owning process if cleanup ever fails.
    const tokenName = pair.tokenPath.split("/").pop()!;
    expect(tokenName.startsWith(`${process.pid}-`)).toBe(true);
  });
});

describe("cleanupAskpassPair", () => {
  test("removes both files", () => {
    const pair = writeAskpassPair("t");
    expect(existsSync(pair.tokenPath)).toBe(true);
    expect(existsSync(pair.shimPath)).toBe(true);

    cleanupAskpassPair(pair);

    expect(existsSync(pair.tokenPath)).toBe(false);
    expect(existsSync(pair.shimPath)).toBe(false);
  });

  test("is a no-op when files are already gone (idempotent)", () => {
    const pair = writeAskpassPair("t");
    cleanupAskpassPair(pair);
    // Second call should not throw.
    expect(() => cleanupAskpassPair(pair)).not.toThrow();
  });

  test("is a no-op for a never-existed pair", () => {
    expect(() =>
      cleanupAskpassPair({
        tokenPath: join(tmpHshHome, "askpass", "never-existed.token"),
        shimPath: join(tmpHshHome, "askpass", "never-existed.sh"),
      }),
    ).not.toThrow();
  });
});

describe("sweepOrphanAskpass", () => {
  test("removes .token and .sh files older than 5 minutes", () => {
    const old = writeAskpassPair("old-token");
    const fresh = writeAskpassPair("fresh-token");

    // Backdate the 'old' pair by 6 minutes.
    const past = new Date(Date.now() - 6 * 60 * 1000);
    utimesSync(old.tokenPath, past, past);
    utimesSync(old.shimPath, past, past);

    sweepOrphanAskpass();

    expect(existsSync(old.tokenPath)).toBe(false);
    expect(existsSync(old.shimPath)).toBe(false);
    expect(existsSync(fresh.tokenPath)).toBe(true);
    expect(existsSync(fresh.shimPath)).toBe(true);
  });

  test("ignores files with unexpected extensions (defense in depth)", () => {
    // If the dir somehow grows a stray file (user dropped one in,
    // OS dotfile, etc.), the sweeper must NOT delete it.
    const pair = writeAskpassPair("t");
    const stray = join(tmpHshHome, "askpass", "stray.txt");
    writeFileSync(stray, "not a hsh file");
    const past = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    utimesSync(stray, past, past);

    sweepOrphanAskpass();

    expect(existsSync(stray)).toBe(true);
    cleanupAskpassPair(pair);
    rmSync(stray);
  });

  test("is a no-op when ~/.hsh/askpass/ does not exist yet", () => {
    // Don't create anything. Should not throw, should not create the dir.
    expect(() => sweepOrphanAskpass()).not.toThrow();
  });

  test("respects injected `now` for deterministic testing", () => {
    const pair = writeAskpassPair("t");
    // Pretend it's 10 minutes from now.
    const future = Date.now() + 10 * 60 * 1000;
    sweepOrphanAskpass(future);
    expect(existsSync(pair.tokenPath)).toBe(false);
    expect(existsSync(pair.shimPath)).toBe(false);
  });
});

describe("parseSshVersion", () => {
  // Real-world `ssh -V` outputs collected from various distros + macOS.
  // The trailing context after the version string varies wildly; the
  // parser MUST anchor on `OpenSSH_<n>.<n>` and ignore the rest.
  test.each([
    [
      "OpenSSH_9.6p1 Ubuntu-3ubuntu13.16, OpenSSL 3.0.13 30 Jan 2024",
      9,
      6,
    ],
    [
      "OpenSSH_9.4p1, LibreSSL 3.3.6",
      9,
      4,
    ],
    [
      "OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w  11 Sep 2023",
      8,
      4,
    ],
    [
      "OpenSSH_7.9p1, OpenSSL 1.1.1d  10 Sep 2019",
      7,
      9,
    ],
    [
      // Apple's bundled ssh on macOS Sonoma.
      "OpenSSH_9.4p1, LibreSSL 3.3.6",
      9,
      4,
    ],
    [
      // Windows OpenSSH server.
      "OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3",
      8,
      6,
    ],
    [
      // Just the marker, nothing else (some embedded distros).
      "OpenSSH_8.0",
      8,
      0,
    ],
  ])("%s → %i.%i", (input, major, minor) => {
    expect(parseSshVersion(input)).toEqual({ major, minor });
  });

  test.each([
    "Dropbear v2022.83",
    "libssh 0.10.5",
    "",
    "ssh: usage: ssh [...]",
    "OpenSSH (no version)",
    "garbage",
  ])("rejects non-OpenSSH input: %s", (input) => {
    expect(parseSshVersion(input)).toBeNull();
  });
});

describe("isVersionSupported", () => {
  test("8.4 is the threshold (inclusive)", () => {
    expect(isVersionSupported({ major: 8, minor: 4 })).toBe(true);
    expect(isVersionSupported({ major: 8, minor: 3 })).toBe(false);
  });

  test("any 9.x is supported", () => {
    expect(isVersionSupported({ major: 9, minor: 0 })).toBe(true);
    expect(isVersionSupported({ major: 9, minor: 6 })).toBe(true);
  });

  test("anything 7.x or lower is unsupported", () => {
    expect(isVersionSupported({ major: 7, minor: 9 })).toBe(false);
    expect(isVersionSupported({ major: 1, minor: 0 })).toBe(false);
  });

  test("future 10.x is supported", () => {
    expect(isVersionSupported({ major: 10, minor: 0 })).toBe(true);
  });

  test("null (parse failure) is unsupported", () => {
    expect(isVersionSupported(null)).toBe(false);
  });
});

describe("isAskpassEnabled", () => {
  test("default (no env var) is enabled", () => {
    delete process.env.HSH_SSH_ASKPASS;
    expect(isAskpassEnabled()).toBe(true);
  });

  test.each(["0", "off", "OFF", "false", "False", "no", "  off  "])(
    "explicit off value '%s' disables",
    (val) => {
      process.env.HSH_SSH_ASKPASS = val;
      expect(isAskpassEnabled()).toBe(false);
    },
  );

  test.each(["1", "true", "yes", "on", "", "  "])(
    "anything else (e.g. '%s') keeps it enabled",
    (val) => {
      process.env.HSH_SSH_ASKPASS = val;
      expect(isAskpassEnabled()).toBe(true);
    },
  );
});

describe("buildAskpassEnv", () => {
  test("sets the three required keys", () => {
    delete process.env.DISPLAY;
    const env = buildAskpassEnv("/tmp/shim.sh");
    expect(env.SSH_ASKPASS).toBe("/tmp/shim.sh");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    // No DISPLAY in parent → fall back to ":0" so askpass mechanism
    // is enabled. The value is irrelevant beyond "non-empty".
    expect(env.DISPLAY).toBe(":0");
  });

  test("preserves the user's DISPLAY when set", () => {
    process.env.DISPLAY = "host.example.com:10.0";
    const env = buildAskpassEnv("/tmp/shim.sh");
    expect(env.DISPLAY).toBe("host.example.com:10.0");
  });

  test("treats empty DISPLAY as unset (askpass needs non-empty)", () => {
    process.env.DISPLAY = "";
    const env = buildAskpassEnv("/tmp/shim.sh");
    expect(env.DISPLAY).toBe(":0");
  });
});

describe("shim end-to-end (the actual mechanism real ssh would use)", () => {
  test("invoking the shim returns the original token on stdout", () => {
    // This is the closest test we can get to "what real ssh does":
    // OpenSSH execs SSH_ASKPASS as a subprocess and reads its stdout.
    // We do exactly the same thing here.
    const pair = writeAskpassPair("the-token-payload");

    const res = spawnSync(pair.shimPath, [], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("the-token-payload");
    // The token must NOT have a trailing newline that real ssh would
    // pick up as part of the password.
    expect(res.stdout.endsWith("\n")).toBe(false);

    cleanupAskpassPair(pair);
  });

  test("shim copes with tokens containing shell metacharacters", () => {
    // Tokens are random base64-ish strings in production, but be
    // defensive: a future gateway change could include $, `, \, etc.
    // The shim must `cat` (not echo / printf) so byte-for-byte fidelity
    // is preserved. ENG-359/361 history: silent corruption like this
    // is the most painful kind of regression.
    const messy = `weird$token\`with"quotes\\and$(echo nope)`;
    const pair = writeAskpassPair(messy);
    const res = spawnSync(pair.shimPath, [], { encoding: "utf-8" });
    expect(res.stdout).toBe(messy);
    cleanupAskpassPair(pair);
  });

  test("shim returns empty stdout when token file is gone (graceful degrade)", () => {
    // If a sweeper races us and removes the token file between shim
    // invocation and ssh's read, ssh sees an empty password and
    // fails normally with "Permission denied" rather than the shim
    // crashing with a confusing error. Pin this contract.
    const pair = writeAskpassPair("t");
    rmSync(pair.tokenPath);
    const res = spawnSync(pair.shimPath, [], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    cleanupAskpassPair(pair);
  });
});

describe("withAskpassEnv", () => {
  test("merges parent env with askpass keys (askpass wins on conflict)", () => {
    const parent = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      SSH_ASKPASS: "/old/shim",
      SSH_ASKPASS_REQUIRE: "prefer",
    } as NodeJS.ProcessEnv;

    const merged = withAskpassEnv(parent, "/new/shim");

    // Parent keys are preserved.
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.HOME).toBe("/home/u");
    // Askpass overrides anything the user already had set.
    expect(merged.SSH_ASKPASS).toBe("/new/shim");
    expect(merged.SSH_ASKPASS_REQUIRE).toBe("force");
  });

  test("does not mutate the parent env", () => {
    const parent: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    withAskpassEnv(parent, "/shim");
    expect(parent.SSH_ASKPASS).toBeUndefined();
  });
});
