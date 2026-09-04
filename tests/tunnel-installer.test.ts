/**
 * tests/tunnel-installer.test.ts — contract tests for the DEP-141
 * daemon setup flow.
 *
 * What matters here is the security contract: the binary this module
 * downloads is executed as root, so an unverifiable or tampered asset
 * must never reach disk, and a stale daemon from a previous install
 * must never survive a failed one. Those paths are exercised against a
 * local Bun.serve standing in for the GitHub release CDN
 * (HSH_DAEMON_RELEASE_BASE points the flow at it).
 *
 * The privileged leg (`sudo hsh-tunneld install`) is covered through
 * runPrivilegedInstall with a fake daemon script: we assert the exit
 * status is propagated as a typed error rather than swallowed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DaemonInstallError,
  daemonAssetName,
  daemonInstallSupported,
  daemonTargetFor,
  downloadDaemon,
  fetchExpectedSha256,
  installDaemon,
  runPrivilegedInstall,
  stagedDaemonPath,
} from "../src/tunnel/installer.ts";

const DAEMON_BODY = new TextEncoder().encode("#!/bin/sh\nexit 0\n");

let hshHome: string;
let prevHome: string | undefined;
let prevBase: string | undefined;

function sha256(data: Uint8Array): string {
  const h = createHash("sha256");
  h.update(data);
  return h.digest("hex");
}

interface Stub {
  base: string;
  stop: () => void;
  /** Paths the stub was asked for, in order. */
  hits: string[];
}

/**
 * Stand in for the hoop release CDN. `manifest` is the SHA256SUMS body
 * served for every version; `asset` is the payload served for any
 * hsh-tunneld-* request.
 */
function serveRelease(opts: {
  manifest?: string | null;
  asset?: Uint8Array;
}): Stub {
  const hits: string[] = [];
  const asset = opts.asset ?? DAEMON_BODY;
  const owned = new Uint8Array(asset.byteLength);
  owned.set(asset);

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path.endsWith("/SHA256SUMS")) {
        if (opts.manifest == null) return new Response("nope", { status: 404 });
        return new Response(opts.manifest, { status: 200 });
      }
      return new Response(owned, { status: 200 });
    },
  });
  const port = server.port;
  if (typeof port !== "number") throw new Error("Bun.serve gave no port");
  return { base: `http://127.0.0.1:${port}`, stop: () => server.stop(true), hits };
}

beforeEach(() => {
  hshHome = mkdtempSync(join(tmpdir(), "hsh-installer-"));
  prevHome = process.env.HSH_HOME;
  prevBase = process.env.HSH_DAEMON_RELEASE_BASE;
  process.env.HSH_HOME = hshHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HSH_HOME;
  else process.env.HSH_HOME = prevHome;
  if (prevBase === undefined) delete process.env.HSH_DAEMON_RELEASE_BASE;
  else process.env.HSH_DAEMON_RELEASE_BASE = prevBase;
  rmSync(hshHome, { recursive: true, force: true });
});

describe("daemonTargetFor", () => {
  test("maps the platforms the daemon publishes", () => {
    expect(daemonTargetFor("linux", "x64")).toEqual({ goos: "linux", goarch: "amd64" });
    expect(daemonTargetFor("linux", "arm64")).toEqual({ goos: "linux", goarch: "arm64" });
    expect(daemonTargetFor("darwin", "arm64")).toEqual({ goos: "darwin", goarch: "arm64" });
    expect(daemonTargetFor("win32", "x64")).toEqual({ goos: "windows", goarch: "amd64" });
  });

  test("returns null for architectures and platforms with no published build", () => {
    expect(daemonTargetFor("linux", "ia32")).toBeNull();
    expect(daemonTargetFor("linux", "ppc64")).toBeNull();
    expect(daemonTargetFor("freebsd", "x64")).toBeNull();
  });

  test("asset names match the hoop release filenames", () => {
    expect(daemonAssetName({ goos: "linux", goarch: "amd64" })).toBe("hsh-tunneld-linux-amd64");
    expect(daemonAssetName({ goos: "darwin", goarch: "arm64" })).toBe("hsh-tunneld-darwin-arm64");
    expect(daemonAssetName({ goos: "windows", goarch: "amd64" })).toBe(
      "hsh-tunneld-windows-amd64.exe",
    );
  });

  test("install is unsupported where it could only fail", () => {
    // Windows publishes a daemon binary, but its service backend is a
    // stub that refuses — implicit setup must not fire there.
    expect(daemonInstallSupported("win32", "x64")).toBe(false);
    expect(daemonInstallSupported("linux", "ia32")).toBe(false);
    expect(daemonInstallSupported("freebsd", "x64")).toBe(false);
    expect(daemonInstallSupported("linux", "x64")).toBe(true);
    expect(daemonInstallSupported("darwin", "arm64")).toBe(true);
  });
});

describe("fetchExpectedSha256", () => {
  test("returns the manifest entry for the asset", async () => {
    const stub = serveRelease({
      manifest: [
        `${sha256(DAEMON_BODY)}  hsh-tunneld-linux-amd64`,
        "aa".repeat(32) + "  install.sh",
        "",
      ].join("\n"),
    });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      const got = await fetchExpectedSha256("1.86.0", "hsh-tunneld-linux-amd64");
      expect(got).toBe(sha256(DAEMON_BODY));
      expect(stub.hits[0]).toBe("/hoophq/hoop/releases/download/1.86.0/SHA256SUMS");
    } finally {
      stub.stop();
    }
  });

  test("a missing manifest is fatal, not a warning", async () => {
    const stub = serveRelease({ manifest: null });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      await expect(
        fetchExpectedSha256("1.86.0", "hsh-tunneld-linux-amd64"),
      ).rejects.toBeInstanceOf(DaemonInstallError);
    } finally {
      stub.stop();
    }
  });

  test("a manifest without our asset is fatal", async () => {
    const stub = serveRelease({ manifest: `${"bb".repeat(32)}  install.sh\n` });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      await expect(
        fetchExpectedSha256("1.86.0", "hsh-tunneld-linux-amd64"),
      ).rejects.toThrow(/no checksum/i);
    } finally {
      stub.stop();
    }
  });
});

describe("downloadDaemon", () => {
  const target = { goos: "linux", goarch: "amd64" } as const;

  test("verifies against the manifest and stages an executable binary", async () => {
    const stub = serveRelease({
      manifest: `${sha256(DAEMON_BODY)}  hsh-tunneld-linux-amd64\n`,
    });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      const got = await downloadDaemon({ target, version: "1.86.0" });
      expect(got.sha256).toBe(sha256(DAEMON_BODY));
      expect(got.bytes).toBe(DAEMON_BODY.length);
      expect(got.path).toBe(join(hshHome, "bin", "hsh-tunneld"));
      expect(readFileSync(got.path)).toEqual(Buffer.from(DAEMON_BODY));
      expect(statSync(got.path).mode & 0o777).toBe(0o755);
    } finally {
      stub.stop();
    }
  });

  test("a tampered asset is discarded, leaving nothing to execute", async () => {
    const stub = serveRelease({
      // Manifest advertises a hash the served bytes do not have.
      manifest: `${"cc".repeat(32)}  hsh-tunneld-linux-amd64\n`,
    });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      await expect(downloadDaemon({ target, version: "1.86.0" })).rejects.toThrow(
        /SHA256 mismatch/,
      );
      expect(existsSync(stagedDaemonPath(target))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("a failed verify does not leave the previously staged daemon in place", async () => {
    const staged = stagedDaemonPath(target);
    writeFileSync(staged, "OLD DAEMON", { mode: 0o755 });

    const stub = serveRelease({
      manifest: `${"dd".repeat(32)}  hsh-tunneld-linux-amd64\n`,
    });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      await expect(downloadDaemon({ target, version: "1.86.0" })).rejects.toThrow();
      // Stale binary must be gone: silently keeping it would install a
      // daemon version nobody verified for this release.
      expect(existsSync(staged)).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("leaves no .partial files behind after a successful download", async () => {
    const stub = serveRelease({
      manifest: `${sha256(DAEMON_BODY)}  hsh-tunneld-linux-amd64\n`,
    });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;
    try {
      await downloadDaemon({ target, version: "1.86.0" });
    } finally {
      stub.stop();
    }
    const leftovers = require("fs")
      .readdirSync(join(hshHome, "bin"))
      .filter((f: string) => f.includes(".partial"));
    expect(leftovers).toEqual([]);
  });
});

describe("runPrivilegedInstall", () => {
  // These run the "already root" branch only when the test process is
  // root (CI containers); otherwise the sudo branch would prompt. We
  // therefore drive the non-root path through a fake `sudo` on PATH.
  let fakeBin: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), "hsh-fakesudo-"));
    prevPath = process.env.PATH;
    // Fake sudo: strips the leading `--` and execs the rest, so the
    // daemon's own exit code reaches us exactly as real sudo would.
    const sudo = `#!/bin/sh
[ "$1" = "--" ] && shift
exec "$@"
`;
    writeFileSync(join(fakeBin, "sudo"), sudo);
    chmodSync(join(fakeBin, "sudo"), 0o755);
    process.env.PATH = `${fakeBin}:${prevPath ?? ""}`;
  });

  afterEach(() => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    rmSync(fakeBin, { recursive: true, force: true });
  });

  test("passes the install verb and extra args through to the daemon", () => {
    const marker = join(fakeBin, "argv.txt");
    const daemon = join(fakeBin, "hsh-tunneld");
    writeFileSync(daemon, `#!/bin/sh\necho "$@" > ${marker}\nexit 0\n`);
    chmodSync(daemon, 0o755);

    runPrivilegedInstall(daemon, ["--no-start"]);
    expect(readFileSync(marker, "utf-8").trim()).toBe("install --no-start");
  });

  test("a non-zero installer exit becomes a typed error with a retry hint", () => {
    const daemon = join(fakeBin, "hsh-tunneld");
    writeFileSync(daemon, "#!/bin/sh\nexit 3\n");
    chmodSync(daemon, 0o755);

    let caught: unknown;
    try {
      runPrivilegedInstall(daemon);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DaemonInstallError);
    expect((caught as DaemonInstallError).message).toContain("exited with code 3");
    expect((caught as DaemonInstallError).hint).toContain(daemon);
  });
});

describe("installDaemon", () => {
  test("refuses Windows before spending a download on it", async () => {
    // hsh-tunneld's Windows service backend is still a stub that
    // returns ErrUnsupportedPlatform, so downloading 18 MB first would
    // just waste the user's bandwidth.
    if (process.platform !== "win32") return;
    await expect(installDaemon()).rejects.toBeInstanceOf(DaemonInstallError);
  });

  test("reports progress milestones in order", async () => {
    if (process.platform === "win32") return;
    const target = daemonTargetFor(process.platform, process.arch);
    if (!target) return; // unsupported host arch; nothing to assert

    const asset = daemonAssetName(target);
    const stub = serveRelease({ manifest: `${sha256(DAEMON_BODY)}  ${asset}\n` });
    process.env.HSH_DAEMON_RELEASE_BASE = stub.base;

    // The "daemon" this stub serves is a shell script that exits 0, so
    // the privileged step actually runs end to end through a fake sudo
    // and the flow completes — proving the three milestones fire in the
    // documented order rather than short-circuiting on an error.
    const fakeBin = mkdtempSync(join(tmpdir(), "hsh-fakesudo2-"));
    const prevPath = process.env.PATH;
    writeFileSync(join(fakeBin, "sudo"), '#!/bin/sh\n[ "$1" = "--" ] && shift\nexec "$@"\n');
    chmodSync(join(fakeBin, "sudo"), 0o755);
    process.env.PATH = `${fakeBin}:${prevPath ?? ""}`;

    const messages: string[] = [];
    try {
      await installDaemon({ version: "1.86.0", onProgress: (m) => messages.push(m) });
    } finally {
      stub.stop();
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }

    expect(messages[0]).toContain(`hsh-tunneld 1.86.0 for ${target.goos}/${target.goarch}`);
    expect(messages[1]).toContain(sha256(DAEMON_BODY));
    expect(messages[2]).toContain("sudo required");
  });
});
