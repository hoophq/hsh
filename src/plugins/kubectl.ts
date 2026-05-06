import type { Plugin } from "./base.ts";
import {
  ensureAuthenticated,
  forceReauthenticate,
  AuthRequiredError,
  handleAuthRequiredAndExit,
} from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { createClient, ApiUnreachableError, AuthExpiredError } from "../api/client.ts";
import { getCachedCredentials, cacheCredentials, clearCachedCredentials } from "../auth/sessions.ts";
import type { Connection, HttpProxyCredentials } from "../api/types.ts";
import { spinner, error, info, warn, dim } from "../ui/output.ts";
import { debug } from "../ui/log.ts";
import { spawn } from "child_process";
import {
  buildKubeconfigEnv,
  sweepOrphanKubeconfigs,
  writeEphemeralKubeconfig,
} from "./kubeconfig.ts";
import { formatAmbiguityWarning, matchConnection } from "./match.ts";
import { ExitCodes } from "./exit-codes.ts";
import { detectContext } from "./kubectl-context.ts";

function isLocalAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost" || host === "::";
}

function execKubectl(args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise(() => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const child = spawn("kubectl", args, { stdio: "inherit", env });
    // Pass kubectl's exit code through verbatim so $? reflects the underlying
    // tool's status (kubectl returns 1 on most errors, but tools wrapping it —
    // helm, kustomize, k9s — depend on the exact code).
    child.on("exit", (code) => process.exit(code ?? ExitCodes.Success));
    child.on("error", (err) => {
      error(`Failed to start kubectl: ${err.message}`);
      process.exit(ExitCodes.GenericError);
    });
  });
}

async function getK8sCredentials(
  connectionName: string,
  apiUrl: string,
  retried = false,
): Promise<{ resp: { has_review: boolean; review_id?: string; connection_credentials?: unknown }; creds: HttpProxyCredentials }> {
  const cached = getCachedCredentials(connectionName);
  if (cached?.connection_credentials) {
    debug("cache", `kubectl hit name=${connectionName} expire_at=${cached.expire_at}`);
    return { resp: cached, creds: cached.connection_credentials as HttpProxyCredentials };
  }
  debug("cache", `kubectl miss name=${connectionName}`);

  const token = await ensureAuthenticated();
  const client = createClient(apiUrl, token);

  try {
    const resp = await client.createCredentials(connectionName);
    if (resp.connection_credentials) {
      cacheCredentials(connectionName, resp);
    }
    return { resp, creds: resp.connection_credentials as HttpProxyCredentials };
  } catch (err) {
    if (err instanceof AuthExpiredError && !retried) {
      // Gateway returned 401 even though we sent a token. With the
      // X-New-Access-Token transparent-refresh path (ENG-349), this
      // only happens when even the server-side refresh token is dead.
      // forceReauthenticate() now throws AuthRequiredError instead of
      // auto-launching the browser; bubble it up so the run() entry
      // point can format the canonical "session expired" UX.
      debug("auth", `kubectl credential request rejected; refresh token also expired name=${connectionName}`);
      clearCachedCredentials(connectionName);
      await forceReauthenticate(); // never returns — throws AuthRequiredError
    }
    throw err;
  }
}

export const kubectlPlugin: Plugin = {
  name: "kubectl",
  description: "Kubernetes access via Hoop gateway",
  wrappedCommand: "kubectl",

  async run(args: string[]): Promise<void> {
    try {
      return await runInner(args);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // Surfaced from forceReauthenticate() / ensureAuthenticated()
        // anywhere inside runInner(). Print the canonical re-auth
        // message and exit 77 (ExitCodes.AuthRequired). See ENG-359.
        return handleAuthRequiredAndExit();
      }
      throw err;
    }
  },
};

async function runInner(args: string[]): Promise<void> {
    const detection = detectContext(args);
    const contextName = detection.context;
    debug("kubectl", `context detection`, {
      context: contextName,
      source: detection.source,
      fileConsulted: detection.fileConsulted,
    });
    if (!contextName) {
      // 'none' means no kubeconfig was found anywhere — likely in-cluster
      // (pod running kubectl) or genuinely unconfigured. Either way we
      // can't match a Hoop connection, so let kubectl handle it.
      // Other source values reaching here mean the file existed but had no
      // current-context set; same outcome.
      warn("No kubectl context detected. Running kubectl directly.");
      return execKubectl(args);
    }

    const apiUrl = getApiUrl();
    if (!apiUrl) {
      debug("kubectl", "passthrough: api-url not configured");
      return execKubectl(args);
    }

    // ensureAuthenticated() throws AuthRequiredError if there is no
    // usable token on disk (covered by the catch on `run()`).
    let token: string;
    try {
      token = await ensureAuthenticated();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // No session at all: silently fall through to native kubectl.
        // We don't want `kubectl version` etc. to fail just because the
        // user hasn't logged into Hoop — same passthrough policy as
        // the "API unreachable" branch.
        debug("auth", "kubectl: no Hoop session; running kubectl directly");
        return execKubectl(args);
      }
      throw err;
    }
    const client = createClient(apiUrl, token);

    const spin = spinner(`Looking up Kubernetes connection for context: ${contextName}...`);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        spin.stop();
        warn(`Hoop API unreachable (${err.reason}); running kubectl directly`);
        return execKubectl(args);
      }
      if (err instanceof AuthExpiredError) {
        // Gateway gave up on transparent refresh — refresh token is
        // dead. Tell the user clearly and stop. We deliberately do
        // NOT silently passthrough here: if the user *had* a Hoop
        // session and it just died, running raw kubectl against the
        // (likely Hoop-fronted) cluster will produce a confusing
        // x509/auth error instead of an actionable message.
        spin.stop();
        await forceReauthenticate(); // throws AuthRequiredError → caught by run() wrapper
      }
      // Any other error (HTTP 5xx, parse error, …) is passthrough.
      spin.stop();
      return execKubectl(args);
    }

    const result = matchConnection(connections, contextName, "kubectl");
    debug("match", "kubectl", {
      target: contextName,
      level: result.level,
      winner: result.match?.name ?? null,
      candidates: result.candidates.map((c) => c.name),
      ambiguous: result.ambiguous,
    });
    if (!result.match) {
      spin.stop();
      dim(`No Hoop connection found for context: ${contextName}. Running kubectl directly.`);
      return execKubectl(args);
    }
    if (result.ambiguous) {
      spin.stop();
      warn(formatAmbiguityWarning(contextName, result));
    }
    const connection = result.match;

    spin.text = `Connecting to ${connection.name} via Hoop...`;

    let creds: HttpProxyCredentials;
    try {
      const result = await getK8sCredentials(connection.name, apiUrl);

      if (result.resp.has_review && !result.resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${result.resp.review_id}`);
        // EX_TEMPFAIL — credentials weren't issued; user must approve.
        // Scripts should treat this as 'try again later', NOT as success.
        process.exit(ExitCodes.ReviewPending);
      }

      creds = result.creds;
      if (!creds?.hostname) throw new Error("No Kubernetes credentials returned");
    } catch (err: unknown) {
      if (err instanceof ApiUnreachableError) {
        spin.stop();
        warn(`Hoop API unreachable (${err.reason}); running kubectl directly`);
        return execKubectl(args);
      }
      spin.fail("Failed to create credentials");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(ExitCodes.GenericError);
    }

    const cached = getCachedCredentials(connection.name);
    if (cached) {
      const mins = Math.round((new Date(cached.expire_at).getTime() - Date.now()) / 60_000);
      spin.succeed(`Using active session for ${connection.name} (expires in ${mins}m)`);
    } else {
      spin.succeed(`Kubernetes access configured via Hoop (${connection.name})`);
    }

    const gatewayHost = isLocalAddress(creds.hostname) ? new URL(apiUrl).hostname : creds.hostname;
    const scheme = isLocalAddress(creds.hostname) ? "http" : "https";
    const proxyUrl = `${scheme}://${gatewayHost}:${creds.port}`;

    // Render an ephemeral kubeconfig for this connection and merge it ahead
    // of the user's existing KUBECONFIG (or default) for the spawned kubectl
    // process only. The user's ~/.kube/config is never modified.
    const hshKubeconfig = writeEphemeralKubeconfig(connection.name, {
      contextName,
      server: proxyUrl,
      token: creds.proxy_token,
    });
    const kubeconfigEnv = buildKubeconfigEnv(hshKubeconfig, process.env.KUBECONFIG);

    // Opportunistic cleanup of stale orphan kubeconfigs (older than 24h).
    sweepOrphanKubeconfigs();

    return execKubectl(args, { KUBECONFIG: kubeconfigEnv });
}
