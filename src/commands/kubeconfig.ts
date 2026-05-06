import { Command } from "commander";
import {
  ensureAuthenticated,
  forceReauthenticate,
  AuthRequiredError,
  handleAuthRequiredAndExit,
} from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import {
  ApiUnreachableError,
  AuthExpiredError,
  createClient,
} from "../api/client.ts";
import {
  cacheCredentials,
  getCachedCredentials,
} from "../auth/sessions.ts";
import {
  buildKubeconfigEnv,
  writeEphemeralKubeconfig,
} from "../plugins/kubeconfig.ts";
import { matchConnection } from "../plugins/match.ts";
import chalk from "chalk";
import { error } from "../ui/output.ts";

/**
 * stderr-only helpers — this command's stdout is reserved for the path
 * (consumed by `KUBECONFIG=$(hsh kubeconfig ...)`), so any user-facing
 * messaging must go to fd 2.
 */
function infoErr(msg: string): void {
  console.error(chalk.blue(`→ ${msg}`));
}
function warnErr(msg: string): void {
  console.error(chalk.yellow(`⚠ ${msg}`));
}
import { debug } from "../ui/log.ts";
import { ExitCodes } from "../plugins/exit-codes.ts";
import type { HttpProxyCredentials } from "../api/types.ts";

/**
 * `hsh kubeconfig <connection>` — emit an ephemeral kubeconfig path for the
 * named Hoop connection. Designed for use with kubectl-wrapping tools that
 * bypass the shell function (helm, k9s, kustomize, Lens, skaffold, …):
 *
 *   export KUBECONFIG="$(hsh kubeconfig prod-cluster)"
 *   helm install foo ./chart
 *   k9s
 *
 * The output is JUST the absolute path, with a trailing newline. Anything
 * that needs reporting (auth flow, errors, warnings) goes to stderr so the
 * stdout capture into `KUBECONFIG=$(...)` stays clean.
 *
 * Behavior parity with the kubectl plugin:
 *   * Silent refresh: HoopApiClient consumes X-New-Access-Token on every
 *     response and persists the rotated JWT (ENG-349).
 *   * Re-auth path: on a hard 401 (refresh token also dead), surfaces
 *     a clear "session expired, run hsh login" message and exits 77
 *     (ExitCodes.AuthRequired). NO browser auto-launch (ENG-359).
 *   * Cache reuse: getCachedCredentials() short-circuits the API call.
 *   * Ephemeral file: same `~/.hsh/kube/<name>.yaml`, mode 0600, atomic write.
 *   * If the user already has a `KUBECONFIG` set, --merge prepends the hsh
 *     path so other contexts in the user's config remain reachable.
 */
export const kubeconfigCommand = new Command("kubeconfig")
  .description(
    "Emit an ephemeral kubeconfig path for a Hoop Kubernetes connection (use with helm, k9s, kustomize, Lens, etc.)"
  )
  .argument("<connection>", "Hoop Kubernetes connection name")
  .option(
    "-m, --merge",
    "Print the hsh path merged with the existing KUBECONFIG env var (colon-separated, hsh first so it wins precedence)"
  )
  .action(async (connectionName: string, opts: { merge?: boolean }) => {
    try {
      await runKubeconfig(connectionName, opts);
    } catch (err) {
      // AuthRequiredError surfaces from ensureAuthenticated() or
      // forceReauthenticate() anywhere in the action body. Print the
      // canonical re-auth message and exit 77 (ExitCodes.AuthRequired).
      // Unlike the ssh/kubectl plugins this command has no fallback —
      // there is no "native helm" path, the user explicitly asked for
      // a Hoop kubeconfig.
      if (err instanceof AuthRequiredError) {
        return handleAuthRequiredAndExit();
      }
      throw err;
    }
  });

async function runKubeconfig(
  connectionName: string,
  opts: { merge?: boolean },
): Promise<void> {
    const apiUrl = getApiUrl();
    if (!apiUrl) {
      error("API URL not configured. Run: hsh config set api-url <url>");
      process.exit(ExitCodes.GenericError);
    }

    // ensureAuthenticated() throws AuthRequiredError if no usable
    // token; that bubbles up to the action wrapper for the canonical
    // "session expired" UX.
    const token = await ensureAuthenticated();
    const client = createClient(apiUrl, token);

    // 1. Look up the connection. Exact match only — the user typed the name.
    let connections;
    try {
      connections = await client.listConnections();
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        error(`Hoop API unreachable: ${err.reason}`);
        process.exit(ExitCodes.GenericError);
      }
      if (err instanceof AuthExpiredError) {
        // Refresh token also dead — surface the canonical re-auth UX
        // via the action wrapper. Do NOT retry: the gateway already
        // tried to refresh transparently and gave up.
        await forceReauthenticate(); // throws AuthRequiredError
      }
      error(`Failed to list connections: ${String(err)}`);
      process.exit(ExitCodes.GenericError);
    }

    const result = matchConnection(connections, connectionName, "kubectl");
    if (!result.match || result.level !== "exact") {
      error(
        `No Kubernetes connection named '${connectionName}'. Run 'hsh status' or check the Hoop UI for the exact name.`
      );
      process.exit(ExitCodes.GenericError);
    }
    const connection = result.match;

    // 2. Reuse cached credentials when fresh; otherwise issue new ones.
    let creds: HttpProxyCredentials;

    const cached = getCachedCredentials(connection.name);
    if (cached?.connection_credentials) {
      debug("kubeconfig", `cache hit name=${connection.name}`);
      creds = cached.connection_credentials as HttpProxyCredentials;
    } else {
      debug("kubeconfig", `cache miss name=${connection.name}; issuing`);
      try {
        const resp = await client.createCredentials(connection.name);
        if (resp.has_review && !resp.connection_credentials) {
          warnErr("This connection requires approval");
          infoErr(`Review ID: ${resp.review_id}`);
          infoErr("Approve in the Hoop web UI, then re-run this command.");
          process.exit(ExitCodes.ReviewPending);
        }
        if (resp.connection_credentials) {
          cacheCredentials(connection.name, resp);
        }
        creds = resp.connection_credentials as HttpProxyCredentials;
      } catch (err) {
        if (err instanceof ApiUnreachableError) {
          error(`Hoop API unreachable: ${err.reason}`);
          process.exit(ExitCodes.GenericError);
        }
        error(`Failed to issue credentials: ${String(err)}`);
        process.exit(ExitCodes.GenericError);
      }
    }

    if (!creds?.hostname) {
      error("Hoop API returned no Kubernetes credentials.");
      process.exit(ExitCodes.GenericError);
    }

    // 3. Build the proxy URL the same way the kubectl plugin does.
    const isLocal =
      creds.hostname === "0.0.0.0" ||
      creds.hostname === "127.0.0.1" ||
      creds.hostname === "localhost" ||
      creds.hostname === "::";
    const gatewayHost = isLocal ? new URL(apiUrl).hostname : creds.hostname;
    const scheme = isLocal ? "http" : "https";
    const proxyUrl = `${scheme}://${gatewayHost}:${creds.port}`;

    // 4. Write the ephemeral kubeconfig (atomic, mode 0600). The contextName
    //    matches the connection name so kubectl-using tools can pick it up
    //    via `current-context: <connection>` without further config.
    const path = writeEphemeralKubeconfig(connection.name, {
      contextName: connection.name,
      server: proxyUrl,
      token: creds.proxy_token,
    });

    // 5. Print just the path to stdout so it can be captured by $(...).
    //    --merge prepends the user's existing KUBECONFIG (colon-separated).
    const out = opts.merge
      ? buildKubeconfigEnv(path, process.env.KUBECONFIG)
      : path;

    infoErr(`Kubeconfig ready for ${connection.name}`);
    process.stdout.write(out + "\n");
    process.exit(ExitCodes.Success);
}
