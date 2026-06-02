import { join } from "path";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { getHshDir } from "../config/store.ts";
import { safeWriteJson } from "../util/safe-write.ts";
import { getKeychain } from "../keychain/auto.ts";

/**
 * Token metadata persisted to auth.json.
 *
 * The actual token string is stored in the OS keychain (macOS Keychain,
 * libsecret on Linux, or a 0600 fallback file).  auth.json holds only
 * the non-sensitive metadata that drives expiry checks and the `hsh status`
 * display — it no longer contains the bearer token itself.
 *
 * Migration: if an existing auth.json still has a `token` field (written
 * by hsh < 0.3), saveToken() will silently migrate it to the keychain and
 * rewrite auth.json without the field.  getToken() also handles the old
 * format transparently during migration.
 */
export interface AuthData {
  expiresAt: string;
  email?: string;
}

/** Shape of the legacy auth.json that included the token inline. */
interface LegacyAuthData extends AuthData {
  token?: string;
}

function getAuthPath(): string {
  return join(getHshDir(), "auth.json");
}

export function getAuthData(): AuthData | null {
  const path = getAuthPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LegacyAuthData;
    // Strip the legacy token field from the in-memory view.
    const { token: _ignored, ...rest } = parsed;
    return rest;
  } catch {
    return null;
  }
}

export async function getToken(): Promise<string | null> {
  // First, check whether we even have metadata (fast path: no auth.json → not logged in).
  const path = getAuthPath();
  if (!existsSync(path)) {
    // But also check the keychain — a migrate-in-progress or partial state
    // could leave a token without metadata.  Treat as "not authenticated".
    return null;
  }

  let meta: LegacyAuthData;
  try {
    const raw = readFileSync(path, "utf-8");
    meta = JSON.parse(raw) as LegacyAuthData;
  } catch {
    return null;
  }

  // --- Legacy migration path ---
  // If auth.json still carries the token (written by hsh < 0.3), migrate it
  // to the keychain now and rewrite auth.json without it.
  if (meta.token) {
    await migrateFromLegacy(meta);
    // After migration the token is in the keychain; fall through to the
    // normal keychain read below.
  }

  if (isTokenExpired(meta)) {
    return null;
  }

  return getKeychain().get();
}

export async function saveToken(token: string, expiresAt: string, email?: string): Promise<void> {
  // Store the token in the OS keychain.
  await getKeychain().set(token);

  // Persist only the non-sensitive metadata to auth.json.
  const data: AuthData = { expiresAt, ...(email ? { email } : {}) };
  safeWriteJson(getAuthPath(), data, { mode: 0o600 });
}

export async function clearToken(): Promise<void> {
  // Remove from keychain.
  await getKeychain().delete();

  // Remove metadata file.
  const path = getAuthPath();
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
}

export async function isAuthenticated(): Promise<boolean> {
  return (await getToken()) !== null;
}

function isTokenExpired(auth: AuthData): boolean {
  const expiresAt = new Date(auth.expiresAt);
  const now = new Date();
  // Consider expired 60s before actual expiry for safety margin.
  return now.getTime() >= expiresAt.getTime() - 60_000;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function saveTokenFromJwt(token: string): Promise<void> {
  const payload = decodeJwtPayload(token);
  let expiresAt: string;
  let email: string | undefined;

  if (payload?.exp && typeof payload.exp === "number") {
    expiresAt = new Date(payload.exp * 1000).toISOString();
  } else {
    // Default to 24h if no exp claim.
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  if (payload?.email && typeof payload.email === "string") {
    email = payload.email;
  }

  await saveToken(token, expiresAt, email);
}

/**
 * Migrate a legacy auth.json (which carries the token inline) to the keychain.
 * Rewrites auth.json without the token field.
 *
 * Called automatically by getToken() when it detects the old format.
 */
async function migrateFromLegacy(legacy: LegacyAuthData): Promise<void> {
  if (!legacy.token) return;
  try {
    await getKeychain().set(legacy.token);
    const { token: _dropped, ...meta } = legacy;
    safeWriteJson(getAuthPath(), meta, { mode: 0o600 });
  } catch {
    // If migration fails (keychain unavailable), leave auth.json intact
    // so the user isn't locked out.  Next saveToken() will retry.
  }
}
