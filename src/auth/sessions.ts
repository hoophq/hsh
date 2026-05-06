import { join } from "path";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { getHshDir } from "../config/store.ts";
import {
  clearAllEphemeralKubeconfigs,
  clearEphemeralKubeconfig,
} from "../plugins/kubeconfig.ts";
import type { CredentialsResponse } from "../api/types.ts";

const SESSIONS_DIR = "sessions";

function getSessionsDir(): string {
  const dir = join(getHshDir(), SESSIONS_DIR);
  if (!existsSync(dir)) {
    const { mkdirSync } = require("fs");
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sessionPath(connectionName: string): string {
  // Sanitize connection name for filesystem
  const safe = connectionName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(getSessionsDir(), `${safe}.json`);
}

export function getCachedCredentials(connectionName: string): CredentialsResponse | null {
  const path = sessionPath(connectionName);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, "utf-8");
    const cached = JSON.parse(raw) as CredentialsResponse;

    // Check if expired
    const expireAt = new Date(cached.expire_at);
    const now = new Date();
    // Consider expired 30s before actual expiry
    if (now.getTime() >= expireAt.getTime() - 30_000) {
      unlinkSync(path);
      clearEphemeralKubeconfig(connectionName);
      return null;
    }

    return cached;
  } catch {
    // Corrupt file — remove and return null
    try { unlinkSync(path); } catch {}
    clearEphemeralKubeconfig(connectionName);
    return null;
  }
}

export function cacheCredentials(connectionName: string, credentials: CredentialsResponse): void {
  const path = sessionPath(connectionName);
  writeFileSync(path, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
}

export function clearCachedCredentials(connectionName: string): void {
  const path = sessionPath(connectionName);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
  clearEphemeralKubeconfig(connectionName);
}

export function clearAllCachedCredentials(): void {
  const dir = getSessionsDir();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) {
        try { unlinkSync(join(dir, file)); } catch {}
      }
    }
  }
  clearAllEphemeralKubeconfigs();
}
