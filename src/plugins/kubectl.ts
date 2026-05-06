import type { Plugin } from "./base.ts";
import { ensureAuthenticated, forceReauthenticate } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { createClient, ApiUnreachableError, AuthExpiredError } from "../api/client.ts";
import { getCachedCredentials, cacheCredentials, clearCachedCredentials } from "../auth/sessions.ts";
import type { Connection, HttpProxyCredentials } from "../api/types.ts";
import { spinner, error, info, warn, dim } from "../ui/output.ts";
import { spawn } from "child_process";
import {
  buildKubeconfigEnv,
  sweepOrphanKubeconfigs,
  writeEphemeralKubeconfig,
} from "./kubeconfig.ts";

function getCurrentContext(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--context" && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith("--context=")) return args[i].split("=")[1];
  }

  const result = Bun.spawnSync(["kubectl", "config", "current-context"], {
    env: process.env as Record<string, string>,
  });

  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

function findK8sConnection(connections: Connection[], contextName: string): Connection | null {
  const exact = connections.find((c) => c.name === contextName);
  if (exact) return exact;

  const byCluster = connections.find((c) => c.access_schema?.cluster_name === contextName);
  if (byCluster) return byCluster;

  const byTag = connections.find(
    (c) => c.tags?.context === contextName || c.tags?.cluster === contextName
  );
  if (byTag) return byTag;

  const partial = connections.find(
    (c) => c.name.includes(contextName) || contextName.includes(c.name)
  );
  if (partial) return partial;

  return null;
}

function isLocalAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost" || host === "::";
}

function execKubectl(args: string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise(() => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
    const child = spawn("kubectl", args, { stdio: "inherit", env });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      error(`Failed to start kubectl: ${err.message}`);
      process.exit(1);
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
    return { resp: cached, creds: cached.connection_credentials as HttpProxyCredentials };
  }

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
      clearCachedCredentials(connectionName);
      await forceReauthenticate();
      return getK8sCredentials(connectionName, apiUrl, true);
    }
    throw err;
  }
}

export const kubectlPlugin: Plugin = {
  name: "kubectl",
  description: "Kubernetes access via Hoop gateway",
  wrappedCommand: "kubectl",

  async run(args: string[]): Promise<void> {
    const contextName = getCurrentContext(args);
    if (!contextName) {
      warn("No kubectl context detected. Running kubectl directly.");
      return execKubectl(args);
    }

    const apiUrl = getApiUrl();
    if (!apiUrl) return execKubectl(args);

    let token = await ensureAuthenticated();
    let client = createClient(apiUrl, token);

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
        token = await forceReauthenticate();
        client = createClient(apiUrl, token);
        try {
          connections = await client.listConnections();
        } catch (retryErr) {
          spin.stop();
          if (retryErr instanceof ApiUnreachableError) {
            warn(`Hoop API unreachable (${retryErr.reason}); running kubectl directly`);
          }
          return execKubectl(args);
        }
      } else {
        spin.stop();
        return execKubectl(args);
      }
    }

    const connection = findK8sConnection(connections, contextName);
    if (!connection) {
      spin.stop();
      dim(`No Hoop connection found for context: ${contextName}. Running kubectl directly.`);
      return execKubectl(args);
    }

    spin.text = `Connecting to ${connection.name} via Hoop...`;

    let creds: HttpProxyCredentials;
    try {
      const result = await getK8sCredentials(connection.name, apiUrl);

      if (result.resp.has_review && !result.resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${result.resp.review_id}`);
        process.exit(0);
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
      process.exit(1);
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
  },
};
