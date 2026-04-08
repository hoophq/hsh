import { Command } from "commander";
import { login } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { error, success } from "../ui/output.ts";

export const loginCommand = new Command("login")
  .description("Authenticate with Hoop")
  .action(async () => {
    const apiUrl = getApiUrl();
    if (!apiUrl) {
      error("API URL not configured. Run first:");
      console.log("\n  hsh config set api-url https://your-instance.hoop.dev\n");
      process.exit(1);
    }

    await login();
  });
