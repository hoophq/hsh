import { Command } from "commander";
import { getAuthData, isAuthenticated } from "../auth/store.ts";
import { getApiUrl } from "../config/store.ts";
import { listPlugins } from "../plugins/registry.ts";
import { keyValue, warn } from "../ui/output.ts";
import { checkForUpdate } from "../update/check.ts";
import { VERSION } from "../version.ts";
import chalk from "chalk";

export const statusCommand = new Command("status")
  .description("Show current Hoop authentication and configuration status")
  .action(async () => {
    const apiUrl = getApiUrl();
    const auth = getAuthData();
    const authenticated = isAuthenticated();
    const plugins = listPlugins();

    console.log(chalk.bold("\nHoop Shell Plugins (hsh)\n"));

    keyValue({
      "Version": VERSION,
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

    // Cached version check — never blocks the status output (offline-friendly).
    // checkForUpdate() returns within ms when the cache is fresh.
    try {
      const upd = await checkForUpdate();
      if (upd.available && upd.latest) {
        warn(`Update available: ${VERSION} → ${upd.latest}. Run: hsh update`);
        if (upd.releaseUrl) {
          console.log(`  ${chalk.dim(upd.releaseUrl)}`);
        }
        console.log();
      }
    } catch {
      // Best-effort; never let a failed update check break `hsh status`.
    }

    if (!apiUrl) {
      warn("Run: hsh config set api-url <url>");
    }
    if (!authenticated && apiUrl) {
      warn("Run: hsh login");
    }
  });
