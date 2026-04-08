import { Command } from "commander";
import { getAuthData, isAuthenticated } from "../auth/store.ts";
import { getApiUrl } from "../config/store.ts";
import { listPlugins } from "../plugins/registry.ts";
import { keyValue, success, warn } from "../ui/output.ts";
import chalk from "chalk";

export const statusCommand = new Command("status")
  .description("Show current Hoop authentication and configuration status")
  .action(() => {
    const apiUrl = getApiUrl();
    const auth = getAuthData();
    const authenticated = isAuthenticated();
    const plugins = listPlugins();

    console.log(chalk.bold("\nHoop Shell Plugins (hsh)\n"));

    keyValue({
      "API URL": apiUrl ?? chalk.dim("not configured"),
      "Auth": authenticated
        ? chalk.green("authenticated")
        : chalk.red("not authenticated"),
      ...(auth?.email ? { "Email": auth.email } : {}),
      ...(auth?.expiresAt
        ? { "Expires": new Date(auth.expiresAt).toLocaleString() }
        : {}),
      "Plugins": plugins.map((p) => p.name).join(", ") || chalk.dim("none"),
    });

    console.log();

    if (!apiUrl) {
      warn("Run: hsh config set api-url <url>");
    }
    if (!authenticated && apiUrl) {
      warn("Run: hsh login");
    }
  });
