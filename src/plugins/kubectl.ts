import type { Plugin } from "./base.ts";
import { ensureAuthenticated } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { createClient } from "../api/client.ts";
import type { Connection, HttpProxyCredentials } from "../api/types.ts";
import { spinner, success, error, info, warn, dim } from "../ui/output.ts";
import { spawn } from "child_process";

function getCurrentContext(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--context" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith("--context=")) {
      return args[i].split("=")[1];
    }
  }

  // Read current-context from kubectl
  const result = Bun.spawnSync(["kubectl", "config", "current-context"], {
    env: process.env as Record<string, string>,
  });

  if (result.exitCode === 0) {
    return result.stdout.toString().trim() || null;
  }

  return null;
}

function findK8sConnection(connections: Connection[], contextName: string): Connection | null {
  const exactMatch = connections.find((c) => c.name === contextName);
  if (exactMatch) return exactMatch;

  const clusterMatch = connections.find(
    (c) => c.access_schema?.cluster_name === contextName
  );
  if (clusterMatch) return clusterMatch;

  const tagMatch = connections.find(
    (c) => c.tags?.context === contextName || c.tags?.cluster === contextName
  );
  if (tagMatch) return tagMatch;

  const partialMatch = connections.find(
    (c) => c.name.includes(contextName) || contextName.includes(c.name)
  );
  if (partialMatch) return partialMatch;

  return null;
}

function injectKubeconfig(proxyUrl: string, token: string, contextName: string): void {
  Bun.spawnSync(
    ["kubectl", "config", "set-cluster", `hsh-${contextName}`,
      `--server=${proxyUrl}`,
      "--insecure-skip-tls-verify=true"],
    { env: process.env as Record<string, string> }
  );

  Bun.spawnSync(
    ["kubectl", "config", "set-credentials", `hsh-${contextName}`, `--token=${token}`],
    { env: process.env as Record<string, string> }
  );

  Bun.spawnSync(
    ["kubectl", "config", "set-context", contextName,
      `--cluster=hsh-${contextName}`,
      `--user=hsh-${contextName}`],
    { env: process.env as Record<string, string> }
  );
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

    // Ensure authenticated
    const token = await ensureAuthenticated();
    const apiUrl = getApiUrl()!;

    // Find the k8s connection
    const spin = spinner(`Looking up Kubernetes connection for context: ${contextName}...`);
    const client = createClient(apiUrl, token);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch (err: unknown) {
      spin.fail("Failed to fetch connections");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(1);
    }

    const connection = findK8sConnection(connections, contextName);
    if (!connection) {
      spin.stop();
      dim(`No Hoop connection found for context: ${contextName}. Running kubectl directly.`);
      return execKubectl(args);
    }

    spin.text = `Creating credentials for ${connection.name}...`;

    // Create credentials via POST /api/connections/{name}/credentials
    let creds: HttpProxyCredentials;
    try {
      const resp = await client.createCredentials(connection.name);

      if (resp.has_review && !resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${resp.review_id}`);
        info("Waiting for approval in the Hoop web UI...");
        process.exit(0);
      }

      creds = resp.connection_credentials as HttpProxyCredentials;
      if (!creds?.hostname) {
        throw new Error("No Kubernetes credentials returned");
      }
    } catch (err: unknown) {
      spin.fail("Failed to create credentials");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(1);
    }

    spin.text = "Configuring kubectl proxy...";

    // Build proxy URL and inject into kubeconfig
    const scheme = creds.hostname.includes("localhost") || creds.hostname.includes("127.0.0.1") ? "http" : "https";
    const proxyUrl = `${scheme}://${creds.hostname}:${creds.port}`;
    injectKubeconfig(proxyUrl, creds.proxy_token, contextName);

    spin.succeed(`Kubernetes access configured via Hoop (${connection.name})`);

    return execKubectl(args);
  },
};

function execKubectl(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("kubectl", args, {
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });

    child.on("error", (err) => {
      error(`Failed to start kubectl: ${err.message}`);
      process.exit(1);
    });
  });
}
