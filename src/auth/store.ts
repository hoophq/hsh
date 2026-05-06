import { join } from "path";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { getHshDir } from "../config/store.ts";
import { safeWriteJson } from "../util/safe-write.ts";

export interface AuthData {
  token: string;
  expiresAt: string;
  email?: string;
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
    return JSON.parse(raw) as AuthData;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const auth = getAuthData();
  if (!auth) return null;

  if (isTokenExpired(auth)) {
    return null;
  }

  return auth.token;
}

export function saveToken(token: string, expiresAt: string, email?: string): void {
  const data: AuthData = { token, expiresAt, email };
  // Atomic write — concurrent shells racing on auth refresh must never see
  // a torn JSON file (which would force a spurious OAuth round-trip).
  safeWriteJson(getAuthPath(), data, { mode: 0o600 });
}

export function clearToken(): void {
  const path = getAuthPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

function isTokenExpired(auth: AuthData): boolean {
  const expiresAt = new Date(auth.expiresAt);
  const now = new Date();
  // Consider expired 60s before actual expiry for safety margin
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

export function saveTokenFromJwt(token: string): void {
  const payload = decodeJwtPayload(token);
  let expiresAt: string;
  let email: string | undefined;

  if (payload?.exp && typeof payload.exp === "number") {
    expiresAt = new Date(payload.exp * 1000).toISOString();
  } else {
    // Default to 24h if no exp claim
    expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  if (payload?.email && typeof payload.email === "string") {
    email = payload.email;
  }

  saveToken(token, expiresAt, email);
}
