import { Command } from "commander";
import { logout } from "../auth/manager.ts";
import { logoutDaemon } from "./tunnel.ts";
import { success } from "../ui/output.ts";

export const logoutCommand = new Command("logout")
  .description("Clear local Hoop credentials (and the tunnel daemon's, if installed)")
  // Do NOT pass a default here — commander auto-defaults the derived
  // `tunnel` boolean to true and flips it to false when --no-tunnel is
  // present. An explicit `false` default would pin it to false and
  // silently skip the daemon logout (same bug as the login command).
  .option(
    "--no-tunnel",
    "Leave the tunnel daemon logged in, even if it is installed"
  )
  .action(async (opts: { tunnel: boolean }) => {
    // Step 1: clear the CLI's own credentials + cached sessions.
    logout();
    success("Logged out successfully.");

    // Step 2: best-effort daemon logout (clears its token + tears the
    // tunnel down). Silently skipped if the daemon isn't present.
    if (opts.tunnel) {
      await logoutDaemon(true);
    }
  });
