/**
 * tests/login-daemon.test.ts — regression tests for the unified
 * `hsh login` daemon leg (loginDaemon).
 *
 * The bug being guarded: with optional=true, loginDaemon used to skip
 * silently whenever the daemon couldn't be reached — including when the
 * daemon WAS installed but its control token was unreadable. That left
 * the daemon on a stale/expired token while `hsh login` reported
 * success, forcing users to run `hsh tunnel login` manually.
 *
 * The fix: only skip silently when the daemon is GENUINELY ABSENT (no
 * IPC socket on disk). When the socket exists but the login can't be
 * completed, loginDaemon must return false (caller exits non-zero).
 *
 * We drive the real loginDaemon and steer the "is the daemon present"
 * discriminator via the HSH_TUNNELD_SOCKET env override that
 * resolveSocketPath honors. No real daemon is ever contacted: when the
 * socket path points at a non-socket file, TunnelClient.connect throws
 * before any network I/O (no control token), which is exactly the
 * "present but unusable" branch we want to assert on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loginDaemon } from "../src/commands/tunnel.ts";
import { DEFAULT_TOKEN_PATH } from "../src/tunnel/socket-path.ts";

let tmp: string;
const savedSocket = process.env.HSH_TUNNELD_SOCKET;
const savedToken = process.env.HSH_TUNNELD_TOKEN_FILE;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hsh-login-daemon-"));
});

afterEach(() => {
  if (savedSocket === undefined) delete process.env.HSH_TUNNELD_SOCKET;
  else process.env.HSH_TUNNELD_SOCKET = savedSocket;
  if (savedToken === undefined) delete process.env.HSH_TUNNELD_TOKEN_FILE;
  else process.env.HSH_TUNNELD_TOKEN_FILE = savedToken;
  rmSync(tmp, { recursive: true, force: true });
});

describe("loginDaemon optional contract", () => {
  test("daemon present (readable token) but login unusable → returns false, no silent skip", async () => {
    // A readable control token is the 'daemon is installed here' signal
    // that daemonLooksInstalled() keys on — mirroring connect(). With a
    // token present, connect() succeeds, then client.config() fails
    // (nothing is actually listening on the socket), and the optional
    // path must WARN + return false rather than skip silently. This is
    // the exact regression: on the affected host the socket existsSync
    // was false for a live daemon, so the old check skipped silently.
    const sockPath = join(tmp, "hsh.sock");
    const tokPath = join(tmp, "control-token");
    writeFileSync(sockPath, "");
    writeFileSync(tokPath, "test-control-token");
    process.env.HSH_TUNNELD_SOCKET = sockPath;
    process.env.HSH_TUNNELD_TOKEN_FILE = tokPath;

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: true });
    expect(ok).toBe(false);
  });

  test("daemon socket pointed at by env but unusable → returns false (env = user expects a daemon)", async () => {
    // An explicit HSH_TUNNELD_SOCKET override means the user expects a
    // daemon; even with no readable token we must surface the failure,
    // never skip silently.
    const sockPath = join(tmp, "hsh.sock");
    writeFileSync(sockPath, "");
    process.env.HSH_TUNNELD_SOCKET = sockPath;
    process.env.HSH_TUNNELD_TOKEN_FILE = join(tmp, "missing-token");

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: true });
    expect(ok).toBe(false);
  });

  test("genuinely absent daemon (no env, no default token) → silent skip, returns true", async () => {
    // No env overrides and (on the test host) no daemon installed at the
    // platform default path → daemonLooksInstalled() is false → the
    // optional leg must skip silently and NOT fail `hsh login`.
    delete process.env.HSH_TUNNELD_SOCKET;
    delete process.env.HSH_TUNNELD_TOKEN_FILE;

    // Guard: if this box actually has a daemon installed at the default
    // path, the premise doesn't hold — skip rather than report a false
    // failure.
    if (existsSync(DEFAULT_TOKEN_PATH.unix)) return;

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: true });
    expect(ok).toBe(true);
  });

  test("non-optional mode always returns false on an unusable daemon", async () => {
    // `hsh tunnel login` (optional=false): every failure is hard.
    process.env.HSH_TUNNELD_SOCKET = join(tmp, "hsh.sock");
    writeFileSync(process.env.HSH_TUNNELD_SOCKET, "");
    process.env.HSH_TUNNELD_TOKEN_FILE = join(tmp, "missing-token");

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: false });
    expect(ok).toBe(false);
  });
});
