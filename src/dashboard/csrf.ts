/**
 * src/dashboard/csrf.ts — minimal per-process CSRF protection.
 *
 * Threat model
 *
 * The dashboard listens on 127.0.0.1:<port>. Any process on the local
 * machine can hit that port; in particular, a malicious page open in
 * the user's browser could try to drive the daemon by issuing
 * cross-origin requests to our server (e.g. POST /api/logout).
 *
 * Modern browsers refuse cross-origin POSTs with non-CORS-safe
 * headers, but we don't want to depend on that alone. The CSRF token
 * is the belt to the browser's suspenders:
 *
 *   - The server emits a single token at process start, stamps it
 *     into the rendered HTML inside a <meta name="csrf-token"> tag.
 *   - Mutating requests (POST/PUT/DELETE) must echo it back in
 *     X-CSRF-Token. The header itself isn't CORS-safelisted, so a
 *     cross-origin page can't read the meta nor set the header.
 *   - GETs are unprotected: they have no side effects (status,
 *     connections, commands).
 *
 * The token is process-scoped: we mint one at module load and use it
 * for the lifetime of `hsh dashboard`. A fresh invocation gets a new
 * token; that's all the rotation we need for a "user opens dashboard
 * for a few minutes" workflow.
 */

import { randomBytes } from "crypto";

/**
 * 32-byte hex token (64 chars). Plenty of entropy; smaller than a
 * UUID with no formatting noise.
 */
const TOKEN = randomBytes(32).toString("hex");

/**
 * Returns the per-process CSRF token. Always the same string within
 * one `hsh dashboard` run.
 */
export function csrfToken(): string {
  return TOKEN;
}

/**
 * Returns true if `received` is a constant-time match for the
 * current token. Used by the server to gate mutating endpoints.
 */
export function verifyCsrf(received: string | null | undefined): boolean {
  if (!received) return false;
  return constantTimeEquals(received, TOKEN);
}

/**
 * Constant-time string compare. Node's `crypto.timingSafeEqual`
 * requires equal-length Buffers; we normalise first so a short
 * attacker-supplied string doesn't crash with "input buffers must
 * have the same byte length".
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
