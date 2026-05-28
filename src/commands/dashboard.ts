/**
 * `hsh dashboard` — open the local web dashboard in the browser.
 *
 * The command:
 *
 *   1. Connects to the daemon over IPC (or surfaces an actionable
 *      error if the daemon isn't running).
 *   2. Binds a Bun.serve HTTP server on a kernel-allocated port,
 *      127.0.0.1 only.
 *   3. Opens that URL in the user's default browser via the `open`
 *      package.
 *   4. Blocks on SIGINT / SIGTERM (the server runs in the background
 *      until then).
 *
 * The "right" UX is `hsh dashboard` keeps the process foreground
 * while the user is using the page; closing the tab doesn't kill it
 * (there's no clean signal from the browser anyway) but Ctrl-C in
 * the terminal does. A future tray app (RD-218) would launch the
 * same code with `--no-open` and stop it via its own menu.
 */

import { Command } from "commander";
import open from "open";

import { TunnelClient, TunnelUnavailableError } from "../tunnel/ipc-client.ts";
import { error, info } from "../ui/output.ts";
import { startServer } from "../dashboard/server.ts";

interface DashboardOptions {
  port?: string;
  noOpen?: boolean;
  host?: string;
}

export const dashboardCommand = new Command("dashboard")
  .description(
    "Open the local web dashboard for the running hsh-tunneld daemon",
  )
  .option(
    "-p, --port <port>",
    "Bind to a fixed port instead of letting the kernel pick (0 = auto)",
    "0",
  )
  .option(
    "--host <host>",
    "Bind to a specific interface (default 127.0.0.1 — do NOT change unless you know what you're doing)",
    "127.0.0.1",
  )
  .option(
    "--no-open",
    "Skip launching the browser; just print the URL and serve until Ctrl-C",
  )
  .action(async (opts: DashboardOptions) => {
    // 1. Validate flags. We accept `--port 0` (let the kernel choose)
    // and any port in the standard range; reject obvious nonsense
    // early so the user sees a clean error rather than the Bun.serve
    // exception.
    const port = parseInt(opts.port ?? "0", 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      error(`invalid --port value: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    // 2. Talk to the daemon. We fail fast here (rather than letting
    // the browser see the daemon-unreachable panel) because a CLI
    // command should surface the most common error before opening
    // any new windows.
    let client: TunnelClient;
    try {
      client = TunnelClient.connect();
    } catch (err) {
      if (err instanceof TunnelUnavailableError) {
        error(`tunnel daemon unreachable: ${err.message}`);
        info("Install the daemon with:  sudo hsh-tunneld install");
        info("Or check that it's running: sudo systemctl status hsh-tunneld");
      } else {
        error(`failed to connect to daemon: ${(err as Error).message}`);
      }
      process.exitCode = 1;
      return;
    }

    // 3. Start the server.
    const server = startServer({
      hostname: opts.host ?? "127.0.0.1",
      port,
      client,
    });
    const url = `http://${server.hostname}:${server.port}/`;
    info(`Hoop Tunnel dashboard: ${url}`);
    info("Press Ctrl-C to stop.\n");

    // 4. Open the browser unless the user opted out.
    if (!opts.noOpen) {
      try {
        await open(url);
      } catch (err) {
        // `open` failing isn't fatal — the URL is already printed,
        // the user can paste it manually. Surface the failure for
        // debugging but don't return.
        info(
          `(could not launch browser automatically: ${(err as Error).message}; open the URL above manually)`,
        );
      }
    }

    // 5. Block on SIGINT / SIGTERM.
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        server.stop();
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  });
