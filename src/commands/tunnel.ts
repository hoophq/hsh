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
 *   - start         Spawn the bundled daemon in the foreground (dev /
 *                   pre-installer convenience; RD-217 will replace
 *                   this with a real service install).
 *   - stop          Stop a daemon spawned via `hsh tunnel start`.
 *   - daemon-path   Print the resolved hsh-tunneld binary path.
 *
 * Everything here is a thin shell over TunnelClient + the launcher; the
 * actual transport / spawn logic lives in src/tunnel/.
 */

import { Command } from "commander";
import chalk from "chalk";
import { getAuthData, isAuthenticated } from "../auth/store.ts";
import { getApiUrl } from "../config/store.ts";
import { error, info, keyValue, success, warn } from "../ui/output.ts";
import { debug } from "../ui/log.ts";
import {
  TunnelApiError,
  TunnelClient,
  TunnelUnavailableError,
} from "../tunnel/ipc-client.ts";
import {
  checkPrivilegeHelper,
  describeDaemonBinary,
  resolveDaemonBinary,
  spawnDaemon,
} from "../tunnel/daemon-launcher.ts";
import {
  readControlToken,
  resolveSocketPath,
  resolveTokenPath,
} from "../tunnel/socket-path.ts";
import type { Connection } from "../tunnel/types.ts";

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
      keyValue({
        Daemon: s.running ? chalk.green("running") : chalk.yellow("idle"),
        "Daemon version": s.daemon_version,
        Auth: s.logged_in
          ? chalk.green("authenticated")
          : chalk.red("not authenticated"),
        ...(s.since ? { Since: new Date(s.since).toLocaleString() } : {}),
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
// hsh tunnel start  /  hsh tunnel stop
// ----------------------------------------------------------------------

const startSub = new Command("start")
  .description("Spawn the bundled hsh-tunneld daemon in the foreground (dev mode)")
  .option(
    "--socket <path>",
    "Override the IPC socket path (HSH_TUNNELD_SOCKET also works)"
  )
  .option(
    "--token-file <path>",
    "Override the control-token file path (HSH_TUNNELD_TOKEN_FILE also works)"
  )
  .option("--session <seed>", "Session seed (controls the /48 prefix)")
  .action(
    async (opts: { socket?: string; tokenFile?: string; session?: string }) => {
      // 1. Pre-flight: gateway URL + token must be present.
      const apiUrl = getApiUrl();
      if (!apiUrl) {
        error("No API URL configured. Run: hsh config set api-url <url>");
        process.exitCode = 1;
        return;
      }
      if (!isAuthenticated()) {
        error("Not authenticated. Run: hsh login");
        process.exitCode = 1;
        return;
      }
      const auth = getAuthData()!;

      // 2. Find the daemon binary.
      const bin = resolveDaemonBinary();
      if (!bin.path) {
        error(
          `hsh-tunneld binary not found. Set HSH_TUNNELD_PATH or install the bundled package.`
        );
        info(`Searched: ${bin.searched.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      // 3. Pre-flight: sudo / elevation helper.
      const priv = checkPrivilegeHelper();
      if (!priv.ok) {
        error(priv.reason ?? "Privilege helper unavailable");
        process.exitCode = 1;
        return;
      }

      // 4. Decide socket / token paths.
      const socketPath =
        opts.socket ?? process.env.HSH_TUNNELD_SOCKET ?? resolveSocketPath().path;
      const tokenPath =
        opts.tokenFile ??
        process.env.HSH_TUNNELD_TOKEN_FILE ??
        resolveTokenPath().path;

      console.log(chalk.bold("\nStarting hsh-tunneld\n"));
      keyValue({
        Binary: describeDaemonBinary(bin),
        Socket: socketPath,
        "Token file": tokenPath,
        "API URL": apiUrl,
      });
      console.log();
      info("The daemon runs under sudo; you may be prompted for your password.");
      info("Press Ctrl-C to stop the daemon.\n");

      // 5. Spawn. We INHERIT stdio so the operator sees daemon logs in
      //    real time; this command intentionally blocks until the
      //    daemon exits, mirroring how a foreground service runs.
      const proc = spawnDaemon({
        binaryPath: bin.path,
        socketPath,
        tokenPath,
        apiUrl,
        token: auth.token,
        sessionSeed: opts.session,
      });

      // Propagate the daemon's exit code so shells / scripts can branch
      // on it. spawn() returns a ChildProcess that emits 'exit' once.
      const exitCode: number = await new Promise((resolveExit) => {
        proc.on("exit", (code, signal) => {
          debug("tunnel.spawn", "daemon exited", { code, signal });
          // SIGINT / SIGTERM during foreground Ctrl-C should be 0.
          if (code === null && (signal === "SIGINT" || signal === "SIGTERM")) {
            resolveExit(0);
            return;
          }
          resolveExit(code ?? 1);
        });
        proc.on("error", (err) => {
          error(`failed to spawn daemon: ${err.message}`);
          resolveExit(1);
        });
      });
      process.exitCode = exitCode;
    }
  );

const stopSub = new Command("stop")
  .description("Stop a hsh-tunneld daemon started via `hsh tunnel start`")
  .action(() => {
    // For v1 the daemon runs in the foreground under sudo. There is no
    // PID file we maintain. The right answer for the user is "Ctrl-C
    // the foreground process"; we surface that explicitly rather than
    // pretending to manage something we don't.
    //
    // Once RD-217 lands the system-service install, this command will
    // shell out to `systemctl stop hsh-tunneld` / `launchctl unload`
    // / `sc stop hsh-tunneld` depending on platform.
    warn("`hsh tunnel start` runs the daemon in the foreground.");
    info("Press Ctrl-C in that terminal to stop it.");
    info(
      "Once the system-service install lands (RD-217) this will stop the registered service."
    );
  });

// ----------------------------------------------------------------------
// hsh tunnel daemon-path
// ----------------------------------------------------------------------

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
      info("Start it with: hsh tunnel start");
      break;
    case "no-token":
      error(err.message);
      info(
        "If the daemon is running, ensure your user can read the control-token file (default group: `hsh`)."
      );
      break;
    case "connect-failed":
      error(err.message);
      info("Is the daemon running? Try: hsh tunnel start");
      break;
    case "timeout":
      error(err.message);
      info("The daemon may be wedged. Check its logs and restart it.");
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
  .addCommand(startSub)
  .addCommand(stopSub)
  .addCommand(daemonPathSub);
