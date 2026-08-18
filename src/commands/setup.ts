/**
 * `hsh setup` — install the Hoop networking components (DEP-141).
 *
 * The setup journey a user should get after dropping `hsh` on their
 * PATH is: run one command, type their password once, and have the
 * tunnel daemon running as a system service. Before this command they
 * had to know that a second binary existed, which archive it came in,
 * and which of two platform-specific installers to run.
 *
 * This file owns only the user-facing flow (messages, ordering, exit
 * codes). Everything mechanical — asset selection, checksum
 * verification, sudo — lives in src/tunnel/installer.ts.
 */

import { Command } from "commander";
import { getApiUrl } from "../config/store.ts";
import { ExitCodes } from "../plugins/exit-codes.ts";
import { TunnelClient } from "../tunnel/ipc-client.ts";
import { DaemonInstallError, installDaemon } from "../tunnel/installer.ts";
import { readControlToken, resolveTokenPath } from "../tunnel/socket-path.ts";
import { debug } from "../ui/log.ts";
import { dim, error, info, success, warn } from "../ui/output.ts";

/**
 * The banner DEP-141 specifies verbatim. Kept as an exported constant
 * because both `hsh setup` and the implicit setup leg of `hsh login`
 * must print the same line — a user should not be able to tell from
 * the output which entry point ran.
 */
export const SETUP_BANNER = "Installing Hoop Networking Components";

/**
 * Is the tunnel daemon already installed on this machine?
 *
 * Same probe `hsh login` uses (a readable — or merely present —
 * control token proves the daemon or its installer ran here), so the
 * two commands can never disagree about whether setup is needed.
 */
export function daemonInstalled(): boolean {
  if (readControlToken()) return true;
  const tok = resolveTokenPath();
  return tok.exists || tok.fromEnv;
}

/**
 * Download + install the daemon, printing progress. Returns false when
 * the install failed (the caller sets the exit code); the error and its
 * remediation hint have already been rendered.
 */
export async function runSetup(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!opts.force && daemonInstalled()) {
    success("Hoop networking components are already installed.");
    info("Reinstall or upgrade them with: hsh setup --force");
    return true;
  }

  info(SETUP_BANNER);

  try {
    const result = await installDaemon({ onProgress: (m) => dim(`  ${m}`) });
    success(`Installed hsh-tunneld ${result.version}.`);
  } catch (err) {
    if (err instanceof DaemonInstallError) {
      error(err.message);
      if (err.hint) info(err.hint);
      return false;
    }
    error(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  // Hand the daemon the gateway URL the CLI already knows, so the user
  // does not have to configure the same value twice. Best-effort: the
  // installer just added the user to the `hsh` group, and OS group
  // membership only applies to NEW login sessions, so in this shell the
  // control token is usually still unreadable. That is expected, not a
  // failure — we fall through to the "open a new terminal" hint.
  const apiUrl = getApiUrl();
  let daemonConfigured = false;
  if (apiUrl) {
    try {
      const client = TunnelClient.connect();
      const cfg = await client.config();
      // A daemon that already points somewhere keeps pointing there:
      // silently repointing an existing tunnel at a different gateway
      // on a reinstall would be a surprising, hard-to-notice change.
      if (!cfg.api_url) {
        await client.updateConfig({ api_url: apiUrl });
        info(`Daemon gateway set to ${apiUrl}.`);
      } else if (cfg.api_url !== apiUrl) {
        warn(`Daemon is pointed at ${cfg.api_url}, not the CLI's ${apiUrl}.`);
        info(`Change it with: hsh tunnel config set api-url ${apiUrl}`);
      } else {
        info(`Daemon gateway is ${cfg.api_url}.`);
      }
      daemonConfigured = true;
    } catch (err) {
      debug("setup", `daemon config skipped: ${String(err)}`);
    }
  } else {
    warn("No gateway configured yet. Run: hsh config set api-url <url>");
  }

  console.log();
  info("Next steps:");
  if (!daemonConfigured) {
    // Group membership is the reason the CLI cannot reach the daemon
    // from this shell. Say so explicitly — "permission denied on a
    // socket" is the single most confusing post-install state.
    dim("  1. Open a new terminal (or run: newgrp hsh) so your new group applies.");
    dim("  2. hsh login");
  } else {
    dim("  1. hsh login");
  }
  dim("  Then: hsh tunnel connections");
  return true;
}

export const setupCommand = new Command("setup")
  .description("Install the Hoop networking components (hsh-tunneld system service)")
  .option("--force", "Reinstall even if the daemon is already present")
  .action(async (opts: { force?: boolean }) => {
    const ok = await runSetup({ force: opts.force });
    if (!ok) process.exit(ExitCodes.GenericError);
  });
