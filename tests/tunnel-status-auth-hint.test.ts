/**
 * tests/tunnel-status-auth-hint.test.ts — unit tests for isAuthError,
 * the heuristic that decides whether `hsh tunnel status` should hint
 * "re-run hsh tunnel login" based on the daemon's last_error.
 *
 * The daemon reports "authenticated" whenever it merely holds a token;
 * a rejected/expired token only shows up as a buried HTTP error in
 * last_error. isAuthError extracts the auth signal so the UI can give a
 * concrete next step.
 */

import { describe, expect, test } from "bun:test";

import { isAuthError } from "../src/commands/tunnel.ts";

describe("isAuthError", () => {
  test("matches the real serverinfo 401 last_error", () => {
    const real =
      'bring up: fetch serverinfo: GET https://sandbox.hoop.dev/api/serverinfo ' +
      'returned 401 Unauthorized: {"message":"access denied"}';
    expect(isAuthError(real)).toBe(true);
  });

  test("matches a bare 401 / unauthorized / access denied / expired", () => {
    expect(isAuthError("got 401 from gateway")).toBe(true);
    expect(isAuthError("Unauthorized")).toBe(true);
    expect(isAuthError("access denied")).toBe(true);
    expect(isAuthError("token is expired")).toBe(true);
    expect(isAuthError("token expired")).toBe(true);
  });

  test("does NOT match non-auth failures", () => {
    expect(isAuthError("dial tcp: connection refused")).toBe(false);
    expect(isAuthError("configure routes: permission denied")).toBe(false);
    expect(isAuthError("fetch serverinfo: context deadline exceeded")).toBe(false);
    expect(isAuthError("no tunnelable connections found for this user")).toBe(false);
  });

  test("returns false for empty / undefined", () => {
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("")).toBe(false);
  });
});
