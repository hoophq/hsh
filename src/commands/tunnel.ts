/**
 * `hsh tunnel` command group.
 *
 * Drives the hsh-tunneld daemon over its local HTTP/JSON control plane
 * (see src/tunnel/ipc-client.ts and the OpenAPI spec at
 * tunnel/ipc/openapi.yaml in hoophq/hoop).
 *
 * Subcommands:
 *
 *   - status        Show daemon running/logged-in state.
 *   - connections   List the *.hoop names the daemon is serving.
 *   - login         OAuth or local-auth flow against the gateway, with
 *                   the daemon owning the resulting token.
 *   - logout        Clear the daemon's stored token + tear down the
 *                   tunnel (hot, no daemon restart needed).
 *   - config        Get/set daemon-managed config (api-url, grpc-url,
 *                   log-level).
 *   - daemon-path   Print the resolved hsh-tunneld binary path.
 *
 * Service lifecycle (start / stop / restart) is intentionally NOT
 * exposed here — once `hsh-tunneld install` registers the systemd unit
 * (RD-217), the OS service manager owns lifecycle. Use
 * `sudo systemctl {start,stop,status} hsh-tunneld` directly or the
 * platform-agnostic `sudo hsh-tunneld {start,stop,status}` wrapper.
 *
 * Everything here is a thin shell over TunnelClient (IPC); the actual
 * transport logic lives in src/tunnel/.
 */

import { Command } from "commander";
import chalk from "chalk";
import open from "open";
import { error, info, keyValue, spinner, success, warn } from "../ui/output.ts";
import {
  TunnelApiError,
  TunnelClient,
  TunnelUnavailableError,
} from "../tunnel/ipc-client.ts";
import {
  describeDaemonBinary,
  resolveDaemonBinary,
} from "../tunnel/daemon-launcher.ts";
import {
  readControlToken,
  resolveSocketPath,
  resolveTokenPath,
} from "../tunnel/socket-path.ts";
import type { Connection } from "../tunnel/types.ts";
import { getPublicServerInfo } from "../api/serverinfo.ts";
import {
  promptLine,
  promptPassword,
  PromptCancelledError,
} from "../auth/prompt.ts";

// ----------------------------------------------------------------------
// hsh tunnel status
// ----------------------------------------------------------------------

const statusSub = new Command("status")
  .description("Show hsh-tunneld daemon status")
  .action(async () => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }

    try {
      const s = await client.status();
      console.log(chalk.bold("\nHoop Tunnel\n"));
      // `since` may arrive as the Go zero time ("0001-01-01T00:00:00Z")
      // when the daemon never entered the running state — render only
      // when it points at a real date so the UI doesn't say "year 1".
      const since = parseRealDate(s.since);
      keyValue({
        Daemon: s.running ? chalk.green("running") : chalk.yellow("idle"),
        "Daemon version": s.daemon_version,
        Auth: s.logged_in
          ? chalk.green("authenticated")
          : chalk.red("not authenticated"),
        ...(since ? { Since: since.toLocaleString() } : {}),
        ...(s.last_error ? { "Last error": chalk.red(s.last_error) } : {}),
      });
      console.log();
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
    }
  });

// ----------------------------------------------------------------------
// hsh tunnel connections
// ----------------------------------------------------------------------

const connectionsSub = new Command("connections")
  .alias("ls")
  .description("List connections served by the tunnel as *.hoop hostnames")
  .action(async () => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }

    try {
      const conns = await client.connections();
      if (conns.length === 0) {
        info("Daemon is running but no tunnelable connections are available.");
        return;
      }
      renderConnections(conns);
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
    }
  });

// ----------------------------------------------------------------------
// hsh tunnel login / logout
// ----------------------------------------------------------------------

const loginSub = new Command("login")
  .description("Authenticate the daemon with the hoop gateway (browser flow)")
  .option(
    "--no-browser",
    "Print the login URL instead of opening the browser",
    false
  )
  .option(
    "--timeout <seconds>",
    "Cap how long to wait for the browser callback",
    parseTimeout,
    180
  )
  .action(async (opts: { browser: boolean; timeout: number }) => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }

    // Pre-flight: if the daemon doesn't have an api_url set, calling
    // /v1/login/start would fail with a fairly opaque message. Tell
    // the user explicitly so they know which knob to turn.
    let apiUrl: string;
    try {
      const cfg = await client.config();
      if (!cfg.api_url) {
        error("Daemon has no api_url configured.");
        info("Set it first: hsh tunnel config set api-url <url>");
        process.exitCode = 1;
        return;
      }
      apiUrl = cfg.api_url;
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
      return;
    }

    // Discover the gateway's auth method directly (unauthenticated
    // endpoint, no daemon round-trip needed). This lets us branch
    // between the OIDC browser flow and the local-auth email/password
    // prompt without the daemon needing to know which one to pick.
    let serverInfo;
    try {
      serverInfo = await getPublicServerInfo(apiUrl);
    } catch (err) {
      error(`Could not detect auth method: ${(err as Error).message}`);
      info(`Verify the api-url: hsh tunnel config get`);
      process.exitCode = 1;
      return;
    }

    switch (serverInfo.authMethod) {
      case "local":
        await runLocalAuthLogin(client, apiUrl, serverInfo.setupRequired);
        return;
      case "oidc":
        await runOidcLogin(client, opts);
        return;
      case "saml":
        error("SAML authentication is not yet supported by the tunnel daemon.");
        info("Use the Hoop web UI to obtain a token, then write it to the daemon config manually.");
        process.exitCode = 1;
        return;
      default:
        error(`Unsupported auth method '${serverInfo.authMethod}' reported by the gateway.`);
        process.exitCode = 1;
        return;
    }
  });

/**
 * Drive the daemon-owned OIDC flow: POST /v1/login/start → open
 * browser → poll /v1/login/poll until done/error. The daemon owns the
 * callback server (port 3587), so the only state we hold here is the
 * `state` token from /v1/login/start.
 */
async function runOidcLogin(
  client: TunnelClient,
  opts: { browser: boolean; timeout: number }
): Promise<void> {
  let started;
  try {
    started = await client.loginStart();
  } catch (err) {
    renderApiError(err);
    process.exitCode = 1;
    return;
  }

  info(`Opening browser to authenticate at the hoop gateway...`);
  if (opts.browser) {
    try {
      await open(started.browser_url);
    } catch {
      warn("Could not open the browser automatically.");
    }
  }
  info(`If the browser does not open, visit:\n  ${started.browser_url}\n`);

  // Poll until the daemon transitions to done/error or we hit the
  // user-supplied timeout. The daemon enforces its own 3-minute
  // timeout independently; our client timeout exists to bound the
  // foreground command in case the daemon is wedged.
  const spin = spinner("Waiting for the browser callback...");
  const deadline = Date.now() + opts.timeout * 1000;
  try {
    while (Date.now() < deadline) {
      const poll = await client.loginPoll(started.state);
      if (poll.status === "done") {
        spin.succeed("Authenticated. Tunnel coming up...");
        // The daemon hot-starts the netstack inside its OnSuccess
        // callback, so by the time we observe "done" the tunnel is
        // either Up or has reported a bring-up error via lastError.
        // Surface either outcome via a follow-up status call rather
        // than asking the user to run `hsh tunnel status` themselves.
        await reportPostLoginStatus(client);
        return;
      }
      if (poll.status === "error") {
        spin.fail(`Login failed: ${poll.error ?? "unknown error"}`);
        process.exitCode = 1;
        return;
      }
      // pending — wait and retry
      await sleep(1000);
    }
    spin.fail(`Login did not complete within ${opts.timeout}s`);
    process.exitCode = 1;
  } catch (err) {
    spin.stop();
    renderApiError(err);
    process.exitCode = 1;
  }
}

/**
 * Drive the local-auth flow against gateways whose auth_method is
 * "local": prompt for email/password locally, ship them to the daemon
 * via POST /v1/login/local. The daemon does the gateway round-trip
 * and persists the resulting JWT.
 *
 * We deliberately do NOT forward credentials to the gateway from this
 * process: doing so would require the daemon to accept a pre-issued
 * token from the UI, which weakens the trust model (the daemon owns
 * the token). Routing through IPC keeps the daemon as the sole writer
 * of /etc/hsh/config.toml.
 */
async function runLocalAuthLogin(
  client: TunnelClient,
  apiUrl: string,
  setupRequired: boolean
): Promise<void> {
  if (setupRequired) {
    error("This Hoop gateway has no users yet. Register the first admin first:");
    console.error("");
    console.error(
      `  curl -X POST ${apiUrl.replace(/\/+$/, "")}/api/localauth/register \\`
    );
    console.error(`    -H 'Content-Type: application/json' \\`);
    console.error(
      `    -d '{"email":"you@example.com","password":"...","name":"Your Name"}'`
    );
    console.error("");
    console.error("Then run `hsh tunnel login` again.");
    process.exitCode = 1;
    return;
  }

  info("Local authentication. Press Ctrl-C to cancel.");
  let email: string;
  let password: string;
  try {
    email = (await promptLine("Email: ")).trim();
    if (!email) {
      error("Email is required.");
      process.exitCode = 1;
      return;
    }
    password = await promptPassword("Password: ");
    if (!password) {
      error("Password is required.");
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      error("Login cancelled.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const spin = spinner("Authenticating...");
  try {
    await client.loginLocal({ email, password });
    spin.succeed(`Authenticated as ${email}. Tunnel coming up...`);
    await reportPostLoginStatus(client);
  } catch (err) {
    spin.stop();
    if (err instanceof TunnelApiError) {
      // The daemon translates 401/404 from the gateway into a
      // uniform "invalid email or password" string already.
      error(`Login failed: ${err.message}`);
    } else {
      renderApiError(err);
    }
    process.exitCode = 1;
  }
}

const logoutSub = new Command("logout")
  .description("Clear the daemon's stored gateway token")
  .action(async () => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }
    try {
      await client.logout();
      success("Daemon token cleared. Tunnel torn down.");
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
    }
  });

// ----------------------------------------------------------------------
// hsh tunnel config get / set
// ----------------------------------------------------------------------

const configGetSub = new Command("get")
  .description("Show the daemon's current configuration")
  .action(async () => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }
    try {
      const cfg = await client.config();
      keyValue({
        "API URL": cfg.api_url || chalk.dim("(not set)"),
        "gRPC URL": cfg.grpc_url || chalk.dim("(auto-discovered)"),
        "Log level": cfg.log_level,
      });
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
    }
  });

// Set a single config key. Mirrors `hsh config set` style: kebab-case
// keys map to snake_case wire field names.
const configSetSub = new Command("set")
  .description("Update a daemon configuration field (api-url, grpc-url, log-level)")
  .argument("<key>", "Config key (api-url | grpc-url | log-level)")
  .argument("<value>", "New value")
  .action(async (key: string, value: string) => {
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      renderUnavailable(err);
      process.exitCode = 1;
      return;
    }

    const req: Record<string, string> = {};
    switch (key.toLowerCase()) {
      case "api-url":
      case "api_url":
        req.api_url = value.replace(/\/+$/, "");
        break;
      case "grpc-url":
      case "grpc_url":
        req.grpc_url = value;
        break;
      case "log-level":
      case "log_level":
        req.log_level = value;
        break;
      default:
        error(`Unknown config key: ${key}`);
        info("Known keys: api-url, grpc-url, log-level");
        process.exitCode = 1;
        return;
    }

    try {
      await client.updateConfig(req);
      success(`Set ${key} = ${value}`);
      // The daemon picks up api-url on the next login; grpc-url and
      // log-level only apply on the next bring-up. Telling users
      // "log out + back in" is the right hint for the api-url case;
      // we don't differentiate today because most edits happen
      // before login anyway.
      if (key.toLowerCase() === "api-url" || key.toLowerCase() === "api_url") {
        info("Run `hsh tunnel login` to authenticate against the new gateway.");
      } else {
        info("Daemon will use the new value on the next bring-up (login or restart).");
      }
    } catch (err) {
      renderApiError(err);
      process.exitCode = 1;
    }
  });

const configSub = new Command("config")
  .description("Manage daemon configuration (api-url, grpc-url, log-level)")
  .addCommand(configGetSub)
  .addCommand(configSetSub);

// ----------------------------------------------------------------------
// hsh tunnel daemon-path
// ----------------------------------------------------------------------
//
// Service lifecycle (start / stop / restart) intentionally is NOT
// exposed via `hsh tunnel` — once `hsh-tunneld install` has registered
// the systemd unit (RD-217), the OS service manager owns lifecycle.
// Users run `sudo systemctl {start,stop,status} hsh-tunneld` directly;
// `sudo hsh-tunneld {start,stop,status}` is the platform-agnostic
// convenience wrapper for the same operations.
//
// Re-introducing a `hsh tunnel start` here would imply a second
// lifecycle path that competes with systemd, which gets into messy
// "who owns the running process" questions on every restart. The hsh
// CLI's job is unprivileged: it drives the running daemon via IPC and
// gets out of the way for everything that needs root.

const daemonPathSub = new Command("daemon-path")
  .description("Print the resolved hsh-tunneld binary path (debug helper)")
  .action(() => {
    const bin = resolveDaemonBinary();
    const sock = resolveSocketPath();
    const tok = resolveTokenPath();
    keyValue({
      Daemon: describeDaemonBinary(bin),
      ...(bin.fromEnv ? { Source: "HSH_TUNNELD_PATH" } : {}),
      Socket: sock.path + (sock.exists ? "" : chalk.dim(" (missing)")),
      "Token file": tok.path + (tok.exists ? "" : chalk.dim(" (missing)")),
      "Token loaded": readControlToken() ? "yes" : chalk.dim("no"),
    });
  });

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function renderConnections(conns: Connection[]): void {
  // Determine column widths once so subtypes/ports line up. We keep
  // this hand-rolled rather than pulling in a table library; the
  // output is small enough that ASCII alignment is enough.
  const maxName = Math.max(...conns.map((c) => c.name.length));
  const maxSub = Math.max(...conns.map((c) => c.subtype.length));
  const maxHost = Math.max(...conns.map((c) => `${c.name}.hoop`.length));

  console.log(chalk.bold("\nTunneled connections\n"));
  for (const c of conns) {
    const portStr = c.expected_port === 0 ? chalk.dim("any") : String(c.expected_port);
    const host = `${c.name}.hoop`;
    console.log(
      `  ${chalk.cyan(host.padEnd(maxHost))}  ` +
        `${chalk.dim(c.subtype.padEnd(maxSub))}  ` +
        `${chalk.dim("port")} ${portStr.padStart(5)}  ` +
        `${chalk.dim(c.virtual_ip)}`
    );
    void maxName; // referenced for symmetry with possible future "raw name" column
  }
  console.log();
  console.log(chalk.dim(`  Use: psql -h <name>.hoop  /  mysql -h <name>.hoop -u … -p`));
  console.log();
}

function renderUnavailable(err: unknown): void {
  if (!(err instanceof TunnelUnavailableError)) {
    error(`tunnel: ${(err as Error).message}`);
    return;
  }
  switch (err.reason) {
    case "no-socket":
      error("Tunnel daemon socket not found.");
      info("Install the daemon with:  sudo hsh-tunneld install");
      info("Or start it (already installed):  sudo systemctl start hsh-tunneld");
      break;
    case "no-token":
      error(err.message);
      info(
        "If the daemon is running, ensure your user can read the control-token file (default group: `hsh`)."
      );
      break;
    case "connect-failed":
      error(err.message);
      info("Is the daemon running?  sudo systemctl status hsh-tunneld");
      break;
    case "timeout":
      error(err.message);
      info("The daemon may be wedged.  sudo journalctl -u hsh-tunneld -n 50");
      break;
  }
}

function renderApiError(err: unknown): void {
  if (err instanceof TunnelApiError) {
    if (err.isUnauthorized()) {
      error("Daemon rejected the control token.");
      info("The daemon may have rotated its token; try again.");
      return;
    }
    if (err.isNotImplemented()) {
      warn(`Endpoint not implemented in this daemon build: ${err.message}`);
      return;
    }
    error(`daemon error: ${err.message} (HTTP ${err.statusCode})`);
    return;
  }
  if (err instanceof TunnelUnavailableError) {
    renderUnavailable(err);
    return;
  }
  error(`tunnel: ${(err as Error).message}`);
}

// ----------------------------------------------------------------------
// Public export
// ----------------------------------------------------------------------

export const tunnelCommand = new Command("tunnel")
  .description("Control the hsh-tunneld daemon (local tunnel for *.hoop hosts)")
  .addCommand(statusSub)
  .addCommand(connectionsSub)
  .addCommand(loginSub)
  .addCommand(logoutSub)
  .addCommand(configSub)
  .addCommand(daemonPathSub);

/**
 * Promise-friendly setTimeout. Used by the login-poll loop so we don't
 * busy-spin against the daemon while waiting for the user's browser
 * callback.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a successful login the daemon hot-starts the tunnel from its
 * persistTokenFromLogin hook (RD-216 hot-reload). The bring-up can
 * either succeed (Status.running flips to true) or fail (Status.running
 * stays false but Status.last_error is populated).
 *
 * We do a short polling loop here — bring-up usually finishes in
 * 50-200ms, but the gateway dial + connection fetch take a few hundred
 * milliseconds in pessimistic cases. Cap the wait so a wedged daemon
 * doesn't hold the CLI forever; the user can always run `hsh tunnel
 * status` themselves later.
 */
async function reportPostLoginStatus(client: TunnelClient): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const s = await client.status();
      if (s.running) {
        success("Tunnel is up.");
        info("Run `hsh tunnel connections` to list reachable hosts.");
        return;
      }
      if (s.last_error) {
        error(`Tunnel failed to come up: ${s.last_error}`);
        info("Run `hsh tunnel status` for the current state.");
        return;
      }
    } catch {
      // ignore transient errors during the bring-up window
    }
    await sleep(200);
  }
  warn(
    "Tunnel did not report Running within 5s — run `hsh tunnel status` to check progress."
  );
}

/**
 * Coerce the `--timeout` flag (which commander passes as a string) into
 * a positive integer. We accept any value parseable as a number and
 * fall back to the previous flag value on garbage, which matches
 * commander's documented coercer signature.
 */
/**
 * Coerce a wire-format date into a JS Date if it represents a real
 * moment. Go marshals zero-time as "0001-01-01T00:00:00Z" which JS
 * parses as a valid Date in the year 1 — we want to treat that as
 * "no value" instead of rendering "12/31/1".
 */
function parseRealDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return undefined;
  // Anything older than 1970 is treated as the zero value. Real
  // daemon-recorded timestamps are clock-wall now-ish.
  if (d.getTime() < 0) return undefined;
  return d;
}

function parseTimeout(value: string, _previous: number): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid --timeout value: ${value} (want a positive integer)`);
  }
  return n;
}
