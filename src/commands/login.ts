import { Command } from "commander";
import { login } from "../auth/manager.ts";
import { loginDaemon } from "./tunnel.ts";
import { getApiUrl } from "../config/store.ts";
import { error } from "../ui/output.ts";

export const loginCommand = new Command("login")
  .description("Authenticate with Hoop (and the tunnel daemon if installed)")
  .option(
    "--no-tunnel",
    "Skip authenticating the tunnel daemon, even if it is installed",
    false
  )
  .option(
    "--no-browser",
    "Print the login URL instead of opening the browser (tunnel daemon flow)",
    false
  )
  .action(async (opts: { tunnel: boolean; browser: boolean }) => {
    const apiUrl = getApiUrl();
    if (!apiUrl) {
      error("API URL not configured. Run first:");
      console.log("\n  hsh config set api-url https://your-instance.hoop.dev\n");
      process.exit(1);
    }

    // Step 1: authenticate the CLI itself (token in the OS keychain).
    // This is what the kubectl/ssh plugins use. Always runs.
    await login();

    // Step 2: best-effort daemon login. The hsh-tunneld daemon owns its
    // own token (it does its own gateway round-trip via IPC — we never
    // hand it the CLI's token, preserving the daemon-owns-token trust
    // model). If the daemon isn't installed/running/configured this is
    // a silent no-op, so a tunnel-less setup sees no change in behavior.
    if (opts.tunnel) {
      await loginDaemon({ browser: opts.browser, timeout: 180, optional: true });
    }
  });
