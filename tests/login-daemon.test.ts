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
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { loginDaemon } from "../src/commands/tunnel.ts";

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
  test("genuinely absent daemon (no socket) → silent skip, returns true", async () => {
    // Point at a socket path that does not exist on disk.
    process.env.HSH_TUNNELD_SOCKET = join(tmp, "does-not-exist.sock");
    delete process.env.HSH_TUNNELD_TOKEN_FILE;

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: true });
    // Absent daemon must NOT fail `hsh login`.
    expect(ok).toBe(true);
  });

  test("installed daemon we can't authenticate against → returns false (no silent skip)", async () => {
    // Create a real file at the socket path so resolveSocketPath reports
    // exists=true (daemon "present"), but provide no readable control
    // token so connect() throws — the exact "present but unusable" case
    // that previously skipped silently.
    const sockPath = join(tmp, "hsh.sock");
    writeFileSync(sockPath, "");
    process.env.HSH_TUNNELD_SOCKET = sockPath;
    // Token file points at a missing path → connect() throws no-token.
    process.env.HSH_TUNNELD_TOKEN_FILE = join(tmp, "missing-token");

    const ok = await loginDaemon({ browser: false, timeout: 1, optional: true });
    // Present-but-unusable must surface as a failure so the caller
    // exits non-zero and the user knows to run `hsh tunnel login`.
    expect(ok).toBe(false);
  });
});
