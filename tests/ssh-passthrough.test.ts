import { describe, expect, test } from "bun:test";
import { buildPassthroughSpawn } from "../src/plugins/ssh.ts";

/**
 * Passthrough fidelity contract: when hsh decides a target is NOT a Hoop
 * connection (no host, no API URL, no auth, or no match — see ENG-351 for
 * the matching rules), the spawned `ssh` invocation MUST be byte-identical
 * to what `ssh <argv>` would do directly.
 *
 * This file pins that contract by asserting the spawn descriptor for a
 * matrix of real-world SSH invocations. The actual `spawn` call in
 * production code uses the same descriptor (see `passthrough()` in
 * src/plugins/ssh.ts).
 *
 * The matrix mirrors `docs/testing/passthrough.md`, which is the manual
 * release-checklist counterpart for things we can't automate (real SSH
 * server, ProxyJump, ControlMaster reuse, scp/rsync wrappers).
 */

interface Case {
  name: string;
  argv: string[];
}

const cases: Case[] = [
  // Plain forms
  { name: "bare hostname", argv: ["host1"] },
  { name: "user@host", argv: ["alice@host1"] },
  { name: "FQDN", argv: ["host1.internal.example.com"] },

  // ssh_config interactions
  {
    name: "host alias from ~/.ssh/config (single positional)",
    argv: ["my-alias"],
  },
  {
    name: "alternate config file via -F",
    argv: ["-F", "/path/to/alt/ssh_config", "host1"],
  },

  // ProxyJump
  {
    name: "ProxyJump via -J",
    argv: ["-J", "jumphost", "target"],
  },
  {
    name: "ProxyJump with user via -J user@jumphost",
    argv: ["-J", "alice@jumphost", "target"],
  },
  {
    name: "ProxyJump chain via -J host1,host2",
    argv: ["-J", "h1,h2,h3", "target"],
  },

  // ControlMaster (multiplexing)
  {
    name: "ControlMaster auto + ControlPath",
    argv: [
      "-o", "ControlMaster=auto",
      "-o", "ControlPath=/tmp/.ssh-mux-%C",
      "-o", "ControlPersist=10m",
      "host1",
    ],
  },

  // Identity / port / user variants
  {
    name: "explicit identity file via -i",
    argv: ["-i", "~/.ssh/id_ed25519", "host1"],
  },
  {
    name: "joined identity file (-i/path)",
    argv: ["-i/home/u/.ssh/id_ed25519", "host1"],
  },
  {
    name: "non-default port via -p",
    argv: ["-p", "2222", "host1"],
  },
  {
    name: "joined port (-p2222)",
    argv: ["-p2222", "host1"],
  },
  {
    name: "user via -l flag",
    argv: ["-l", "alice", "host1"],
  },

  // Verbosity, agent, tty
  {
    name: "stacked verbose -vvv",
    argv: ["-vvv", "host1"],
  },
  {
    name: "agent forwarding -A",
    argv: ["-A", "host1"],
  },
  {
    name: "force tty -tt",
    argv: ["-tt", "host1", "top"],
  },

  // Tunnels / forwards
  {
    name: "local port forward -L",
    argv: ["-L", "8080:localhost:80", "host1"],
  },
  {
    name: "remote port forward -R",
    argv: ["-R", "9090:localhost:9090", "host1"],
  },
  {
    name: "dynamic SOCKS proxy -D",
    argv: ["-D", "1080", "host1"],
  },

  // Remote command (must be preserved verbatim including flags-looking args)
  {
    name: "remote command with positional args",
    argv: ["host1", "uname", "-a"],
  },
  {
    name: "remote command with flags after --",
    argv: ["host1", "--", "-some-remote-flag"],
  },
  {
    name: "remote command with quoted shell",
    argv: ["host1", "bash", "-c", "echo hello && uname -a"],
  },

  // URI form
  {
    name: "ssh:// URI form (passes through verbatim)",
    argv: ["ssh://alice@host1:2222"],
  },

  // Long realistic invocations from the wild
  {
    name: "scp-style equivalent (same argv shape; scp wraps ssh internally)",
    argv: ["-o", "BatchMode=yes", "-i", "~/.ssh/id", "host1"],
  },
  {
    name: "rsync-style flags (rsync invokes 'ssh -l user host')",
    argv: ["-l", "deploy", "-p", "2222", "-o", "StrictHostKeyChecking=no", "host1"],
  },
  {
    name: "git push over ssh equivalent",
    argv: ["-T", "git@github.com"],
  },
  {
    name: "complex realistic SSH invocation",
    argv: [
      "-vv",
      "-i", "~/.ssh/id_ed25519",
      "-o", "ServerAliveInterval=30",
      "-o", "ProxyCommand=cloudflared access ssh --hostname %h",
      "-J", "bastion.example.com",
      "-L", "5432:db.internal:5432",
      "alice@host1",
      "uname",
      "-a",
    ],
  },
];

describe("SSH passthrough fidelity (argv byte-identity)", () => {
  for (const c of cases) {
    test(c.name, () => {
      const desc = buildPassthroughSpawn(c.argv);
      // The contract: cmd is exactly "ssh", argv is the SAME REFERENCE
      // (not a copy with mutations), and the only spawn option is
      // stdio: "inherit" so prompts, pty, and binary streams (scp / sftp
      // pipelines) all flow without alteration.
      expect(desc.cmd).toBe("ssh");
      expect(desc.args).toBe(c.argv);          // same array reference
      expect(desc.args).toEqual(c.argv);       // and same values (paranoia)
      expect(desc.options).toEqual({ stdio: "inherit" });
    });
  }
});

describe("SSH passthrough invariants", () => {
  test("never injects -p / -l / destination rewrite", () => {
    const argv = ["host1"];
    const desc = buildPassthroughSpawn(argv);
    expect(desc.args).toEqual(["host1"]);
    expect(desc.args).not.toContain("-p");
    expect(desc.args).not.toContain("-l");
  });

  test("never sets a custom env (child inherits parent's env)", () => {
    const desc = buildPassthroughSpawn(["host"]);
    // The descriptor explicitly does NOT include `env`, so child_process.spawn
    // will inherit process.env unmodified (Node + Bun semantics).
    expect("env" in desc.options).toBe(false);
  });

  test("never sets a custom cwd (child inherits parent's cwd)", () => {
    const desc = buildPassthroughSpawn(["host"]);
    expect("cwd" in desc.options).toBe(false);
  });

  test("stdio is 'inherit' so binary streams (scp/sftp pipelines) flow untouched", () => {
    const desc = buildPassthroughSpawn(["host"]);
    expect(desc.options.stdio).toBe("inherit");
  });

  test("empty argv passes through (ssh prints its own usage)", () => {
    const desc = buildPassthroughSpawn([]);
    expect(desc.args).toEqual([]);
  });

  test("argv with only flags (no host) passes through (ssh prints usage / version)", () => {
    const desc = buildPassthroughSpawn(["-V"]);
    expect(desc.args).toEqual(["-V"]);
  });
});
