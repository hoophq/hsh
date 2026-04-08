import { Command } from "commander";
import { getConfigValue, setConfigValue, setApiUrl, getConfig } from "../config/store.ts";
import { success, info, keyValue } from "../ui/output.ts";
import chalk from "chalk";

export const configCommand = new Command("config")
  .description("Manage hsh configuration");

configCommand
  .command("set <key> <value>")
  .description("Set a configuration value (e.g., api-url)")
  .action((key: string, value: string) => {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === "apiUrl") {
      setApiUrl(value);
    } else {
      setConfigValue(normalizedKey, value);
    }
    success(`Set ${key} = ${value}`);
  });

configCommand
  .command("get <key>")
  .description("Get a configuration value")
  .action((key: string) => {
    const normalizedKey = normalizeKey(key);
    const value = getConfigValue(normalizedKey);
    if (value) {
      console.log(value);
    } else {
      console.log(chalk.dim("(not set)"));
    }
  });

configCommand
  .command("list")
  .description("List all configuration values")
  .action(() => {
    const config = getConfig();
    const entries = Object.entries(config).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      info("No configuration set. Run: hsh config set api-url <url>");
      return;
    }
    console.log();
    keyValue(Object.fromEntries(entries.map(([k, v]) => [k, v ?? ""])));
    console.log();
  });

function normalizeKey(key: string): string {
  // Convert kebab-case to camelCase (e.g., api-url → apiUrl)
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
