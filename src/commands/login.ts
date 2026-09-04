import { Command } from "commander";
import { openSync, closeSync } from "fs";
import { login } from "../auth/manager.ts";
import { loginDaemon } from "./tunnel.ts";
import { daemonInstalled, runSetup } from "./setup.ts";
import { daemonInstallSupported } from "../tunnel/installer.ts";
import { getApiUrl } from "../config/store.ts";
import { error, info } from "../ui/output.ts";

/**
 * Does this process have a controlling terminal sudo can prompt on?
 *
 * NOT `process.stdin.isTTY`: sudo does not read the password from
 * stdin, it opens /dev/tty directly. `hsh login < file` therefore has
 * a non-TTY stdin while sudo can still prompt perfectly well — gating
 * on stdin would skip setup for anyone who redirects stdin, and (worse)
 * would not actually protect the case it was meant to, since a real
 * CI runner with no tty is exactly where opening /dev/tty fails.
 *
 * Probing /dev/tty is what sudo itself does, so this answers the only
 * question that matters: can the user be prompted?
 */
function hasControllingTerminal(): boolean {
  if (process.platform === "win32") return false;
  try {
    closeSync(openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
}

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
    "Skip the tunnel daemon entirely (no install, no daemon login)"
  )
  .option(
    "--no-browser",
    "Print the login URL instead of opening the browser (tunnel daemon flow)"
  )
  .option(
    "--no-setup",
    "Do not install the tunnel daemon when it is missing"
  )
  .action(async (opts: { tunnel: boolean; browser: boolean; setup: boolean }) => {
    const apiUrl = getApiUrl();
    if (!apiUrl) {
      error("API URL not configured. Run first:");
      console.log("\n  hsh config set api-url https://your-instance.hoop.dev\n");
      process.exit(1);
    }

    // Step 1: authenticate the CLI itself (token in the OS keychain).
    // This is what the kubectl/ssh plugins use. Always runs.
    await login();

    // Step 2: install the tunnel daemon if this machine doesn't have
    // it yet (DEP-141). A first `hsh login` on a fresh machine is the
    // point where the user has just proven they want Hoop access, so
    // it is the natural place to ask for the one sudo password the
    // setup needs. `--no-setup` opts out explicitly.
    //
    // `daemonInstallSupported()` keeps the implicit path silent on
    // hosts where setup could only ever fail (Windows, exotic arches):
    // there is nothing the user could run, and hsh works fine without
    // the tunnel. With no controlling terminal we print a hint instead
    // of running it — sudo would block on a prompt nobody can answer,
    // and a hung pipeline is worse than a missing daemon. An explicit
    // `hsh setup` still runs in both cases and reports the real reason.
    const setupWanted =
      opts.tunnel && opts.setup && !daemonInstalled() && daemonInstallSupported();
    if (setupWanted && hasControllingTerminal()) {
      console.log();
      // A failed install must not be reported as a clean login: the
      // user asked for Hoop access and did not fully get it.
      if (!(await runSetup())) process.exitCode = 1;
    } else if (setupWanted) {
      info("Tunnel daemon is not installed. Run `hsh setup` to install it.");
    }

    // Step 3: best-effort daemon login. The hsh-tunneld daemon owns its
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
