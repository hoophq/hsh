import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";

export interface HshConfig {
  apiUrl?: string;
  [key: string]: string | undefined;
}

const HSH_DIR = join(homedir(), ".hsh");
const CONFIG_PATH = join(HSH_DIR, "config.json");

function ensureDir(): void {
  if (!existsSync(HSH_DIR)) {
    mkdirSync(HSH_DIR, { recursive: true });
  }
}

export function getConfig(): HshConfig {
  ensureDir();
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as HshConfig;
}

function saveConfig(config: HshConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
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
  return HSH_DIR;
}
