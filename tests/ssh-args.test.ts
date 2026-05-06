import { describe, expect, test } from "bun:test";
import { parseSshArgs, rewriteSshArgs } from "../src/plugins/ssh-args.ts";

/**
 * Golden test cases for the SSH argument parser. Every case asserts both
 * extraction (user/host/port) and rewrite (full argv after substitution).
 *
 * The rewrite target is fixed for clarity:
 *   newUser = "hoop-user"
 *   newHost = "gw.example.com"
 *   newPort = "2222"
 */

const REWRITE = { newUser: "hoop-user", newHost: "gw.example.com", newPort: "2222" };

interface Case {
  /** Short label used as the test name. */
  name: string;
  /** Argv after `ssh` (i.e. `process.argv.slice(2)` for an `ssh ...` call). */
  argv: string[];
  /** Expected resolved fields. `null` checks `=== null`. */
  user: string | null;
  host: string | null;
  port: string | null;
  /** Expected rewritten argv. */
  rewrite: string[];
}

const cases: Case[] = [
  {
    name: "bare host",
    argv: ["host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "user@host",
    argv: ["alice@host1"],
    user: "alice",
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "ssh URI form",
    argv: ["ssh://alice@host1:2200"],
    user: "alice",
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "ssh URI form, no user",
    argv: ["ssh://host1:2200"],
    user: null,
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "ssh URI form, IPv6 with port",
    argv: ["ssh://alice@[fe80::1]:2200"],
    user: "alice",
    host: "fe80::1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-p 2200 host",
    argv: ["-p", "2200", "host1"],
    user: null,
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-p2200 host (joined)",
    argv: ["-p2200", "host1"],
    user: null,
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-oPort=2200 host (joined)",
    argv: ["-oPort=2200", "host1"],
    user: null,
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-o Port=2200 host (separate)",
    argv: ["-o", "Port=2200", "host1"],
    user: null,
    host: "host1",
    port: "2200",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-p wins over -o Port=",
    argv: ["-o", "Port=2200", "-p", "9999", "host1"],
    user: null,
    host: "host1",
    port: "9999",
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-l alice host (separate)",
    argv: ["-l", "alice", "host1"],
    user: "alice",
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-l wins over user@host",
    argv: ["-l", "fromflag", "alice@host1"],
    user: "fromflag",
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com"],
  },
  {
    name: "-i /path/to/key host (separate)",
    argv: ["-i", "/home/u/.ssh/k", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-i", "/home/u/.ssh/k", "hoop-user@gw.example.com"],
  },
  {
    name: "-i/path/to/key host (joined)",
    argv: ["-i/home/u/.ssh/k", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-i/home/u/.ssh/k", "hoop-user@gw.example.com"],
  },
  {
    name: "-- realhost (end-of-options consumes the host)",
    argv: ["--", "realhost"],
    user: null,
    host: "realhost",
    port: null,
    rewrite: ["-p", "2222", "--", "hoop-user@gw.example.com"],
  },
  {
    name: "host with remote command",
    argv: ["host1", "echo", "hi"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com", "echo", "hi"],
  },
  {
    name: "verbose stacked + boolean flags preserved verbatim",
    argv: ["-vvv", "-A", "-4", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-vvv", "-A", "-4", "hoop-user@gw.example.com"],
  },
  {
    name: "unknown short flag treated as valueless (no value swallowed)",
    argv: ["-Z", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-Z", "hoop-user@gw.example.com"],
  },
  {
    name: "-o non-port options preserved with original joined-ness",
    argv: ["-oStrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: [
      "-p", "2222",
      "-oStrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "hoop-user@gw.example.com",
    ],
  },
  {
    name: "-L port forwarding preserved",
    argv: ["-L", "8080:localhost:80", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-L", "8080:localhost:80", "hoop-user@gw.example.com"],
  },
  {
    name: "complex realistic invocation",
    argv: [
      "-vv",
      "-i", "~/.ssh/id_ed25519",
      "-o", "ServerAliveInterval=30",
      "-L", "5432:db.internal:5432",
      "alice@host1",
      "uname",
      "-a",
    ],
    user: "alice",
    host: "host1",
    port: null,
    rewrite: [
      "-p", "2222",
      "-vv",
      "-i", "~/.ssh/id_ed25519",
      "-o", "ServerAliveInterval=30",
      "-L", "5432:db.internal:5432",
      "hoop-user@gw.example.com",
      "uname",
      "-a",
    ],
  },
  {
    name: "no host at all (passthrough sentinel)",
    argv: ["-V"],
    user: null,
    host: null,
    port: null,
    // rewrite still produces the prefix; caller decides not to invoke rewrite
    // when host === null. Asserted just to lock the behavior down.
    rewrite: ["-p", "2222", "-V"],
  },
  {
    name: "-Q query option correctly takes a value",
    argv: ["-Q", "cipher", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-Q", "cipher", "hoop-user@gw.example.com"],
  },
  {
    name: "-B bind interface correctly takes a value (was missing in old code)",
    argv: ["-B", "eth0", "host1"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "-B", "eth0", "hoop-user@gw.example.com"],
  },
  {
    name: "subcommand args before a `--` end-of-options marker",
    argv: ["host1", "--", "-flag-for-remote"],
    user: null,
    host: "host1",
    port: null,
    rewrite: ["-p", "2222", "hoop-user@gw.example.com", "--", "-flag-for-remote"],
  },
];

describe("parseSshArgs + rewriteSshArgs (golden cases)", () => {
  for (const c of cases) {
    test(c.name, () => {
      const parsed = parseSshArgs(c.argv);
      expect(parsed.user).toBe(c.user);
      expect(parsed.host).toBe(c.host);
      expect(parsed.port).toBe(c.port);
      expect(rewriteSshArgs(parsed, REWRITE)).toEqual(c.rewrite);
    });
  }
});

describe("parseSshArgs edge cases", () => {
  test("dangling -p with no value emits a bare flag (let ssh complain)", () => {
    const parsed = parseSshArgs(["-p"]);
    expect(parsed.port).toBeNull();
    expect(parsed.host).toBeNull();
    // The dangling flag is preserved verbatim.
    expect(parsed.tokens).toEqual([{ kind: "flag", value: "-p" }]);
  });

  test("empty argv yields all-null", () => {
    const parsed = parseSshArgs([]);
    expect(parsed.user).toBeNull();
    expect(parsed.host).toBeNull();
    expect(parsed.port).toBeNull();
    expect(parsed.tokens).toEqual([]);
  });

  test("port=Port (case-insensitive option key match)", () => {
    expect(parseSshArgs(["-o", "port=2200", "h"]).port).toBe("2200");
    expect(parseSshArgs(["-o", "PORT=2200", "h"]).port).toBe("2200");
    expect(parseSshArgs(["-oPoRt=2200", "h"]).port).toBe("2200");
  });
});

describe("rewriteSshArgs invariants", () => {
  test("always emits exactly one -p (the rewrite target's port)", () => {
    const parsed = parseSshArgs([
      "-p", "1111",
      "-oPort=2222",
      "-o", "Port=3333",
      "host1",
    ]);
    const out = rewriteSshArgs(parsed, REWRITE);
    expect(out.filter((a) => a === "-p" || a.startsWith("-p")).length).toBe(1);
    expect(out).toContain("-p");
    const idx = out.indexOf("-p");
    expect(out[idx + 1]).toBe("2222");
    // No -oPort= survivors of any case
    expect(out.some((a) => /^-o(Port|PORT|port|PoRt)=/.test(a))).toBe(false);
  });

  test("destination is always rewritten to bare user@host (no URI form leaks)", () => {
    const parsed = parseSshArgs(["ssh://alice@host1:2200"]);
    const out = rewriteSshArgs(parsed, REWRITE);
    expect(out).toContain("hoop-user@gw.example.com");
    expect(out.some((a) => a.startsWith("ssh://"))).toBe(false);
  });

  test("-l flag is always dropped", () => {
    const parsed = parseSshArgs(["-l", "alice", "host1"]);
    const out = rewriteSshArgs(parsed, REWRITE);
    expect(out).not.toContain("-l");
    expect(out).not.toContain("alice");
  });
});
