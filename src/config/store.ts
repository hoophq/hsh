import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";

export interface HshConfig {
  apiUrl?: string;
  [key: string]: string | undefined;
}

/**
 * Resolve the hsh state directory.
 *
 * Honors `HSH_HOME` (full path override) or falls back to `~/.hsh`. Resolved
 * lazily on every call so tests / sandboxes can override per-process via
 * `process.env.HSH_HOME`. `homedir()` is cached by Bun at startup, so it
 * cannot be overridden mid-process — `HSH_HOME` is the supported escape hatch.
 */
function hshDir(): string {
  const override = process.env.HSH_HOME;
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".hsh");
}

function configPath(): string {
  return join(hshDir(), "config.json");
}

function ensureDir(): void {
  const dir = hshDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getConfig(): HshConfig {
  ensureDir();
  const path = configPath();
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as HshConfig;
}

function saveConfig(config: HshConfig): void {
  ensureDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
}

export function getApiUrl(): string | undefined {
  return getConfig().apiUrl;
}

export function setApiUrl(url: string): void {
  const config = getConfig();
  config.apiUrl = url.replace(/\/+$/, "");
  saveConfig(config);
}

export function setConfigValue(key: string, value: string): void {
  const config = getConfig();
  config[key] = value;
  saveConfig(config);
}

export function getConfigValue(key: string): string | undefined {
  return getConfig()[key];
}

export function getHshDir(): string {
  ensureDir();
  return hshDir();
}
