import { Command } from "commander";
import { login } from "../auth/manager.ts";
import { loginDaemon } from "./tunnel.ts";
import { getApiUrl } from "../config/store.ts";
import { error } from "../ui/output.ts";

export const loginCommand = new Command("login")
  .description("Authenticate with Hoop (and the tunnel daemon if installed)")
  // NOTE: do NOT pass a default value to a `--no-*` option. Commander
  // auto-defaults the derived boolean (`tunnel`, `browser`) to `true`
  // and flips it to `false` when the flag is present. Passing an
  // explicit `false` here overrides that auto-default, pinning the value
  // to `false` always — which silently disabled the daemon login leg
  // (the `if (opts.tunnel)` below never ran). See the commander docs on
  // "negatable boolean options".
  .option(
    "--no-tunnel",
    "Skip authenticating the tunnel daemon, even if it is installed"
  )
  .option(
    "--no-browser",
    "Print the login URL instead of opening the browser (tunnel daemon flow)"
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
    // model).
    //
    // If the daemon is genuinely not installed this is a silent no-op.
    // But if the daemon IS installed and we fail to update its token
    // (unreachable, unconfigured, login error), loginDaemon returns
    // false and has already warned the user — we propagate a non-zero
    // exit so the failure is visible in scripts and shells. The CLI
    // login itself already succeeded, so this only flags the daemon leg.
    if (opts.tunnel) {
      const ok = await loginDaemon({ browser: opts.browser, timeout: 180, optional: true });
      if (!ok) process.exitCode = 1;
    }
  });
