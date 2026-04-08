import type { Plugin } from "./base.ts";
import { ensureAuthenticated } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { createClient } from "../api/client.ts";
import type { Connection } from "../api/types.ts";
import { spinner, success, error, info, warn, dim } from "../ui/output.ts";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { spawn } from "child_process";

interface KubeConfig {
  apiVersion: string;
  kind: string;
  clusters: KubeCluster[];
  contexts: KubeContext[];
  "current-context"?: string;
  users: KubeUser[];
  [key: string]: unknown;
}

interface KubeCluster {
  name: string;
  cluster: {
    server: string;
    "certificate-authority-data"?: string;
    "insecure-skip-tls-verify"?: boolean;
    [key: string]: unknown;
  };
}

interface KubeContext {
  name: string;
  context: {
    cluster: string;
    user: string;
    namespace?: string;
    [key: string]: unknown;
  };
}

interface KubeUser {
  name: string;
  user: {
    token?: string;
    [key: string]: unknown;
  };
}

function getKubeconfigPath(): string {
  return process.env.KUBECONFIG ?? join(homedir(), ".kube", "config");
}

function readKubeconfig(): KubeConfig {
  const path = getKubeconfigPath();
  if (!existsSync(path)) {
    throw new Error(`Kubeconfig not found at: ${path}`);
  }
  // Parse YAML manually (simple key-value for kubeconfig)
  // We use JSON since kubeconfig can be JSON too, but typically it's YAML
  // For simplicity, use Bun's built-in YAML-like parsing or just read and parse
  const raw = readFileSync(path, "utf-8");

  // Try JSON first
  try {
    return JSON.parse(raw) as KubeConfig;
  } catch {
    // Fall through to YAML parsing
  }

  // Simple YAML parse using js-yaml pattern
  // Since we can't add js-yaml, we'll shell out to kubectl to get JSON
  const result = Bun.spawnSync(["kubectl", "config", "view", "-o", "json", "--raw"], {
    env: process.env as Record<string, string>,
  });

  if (result.exitCode !== 0) {
    throw new Error("Failed to read kubeconfig. Is kubectl installed?");
  }

  return JSON.parse(result.stdout.toString()) as KubeConfig;
}

function backupKubeconfig(): void {
  const path = getKubeconfigPath();
  if (existsSync(path)) {
    const backupPath = `${path}.hsh-backup`;
    copyFileSync(path, backupPath);
  }
}

function getCurrentContext(args: string[]): string | null {
  // Check if --context was specified in args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--context" && i + 1 < args.length) {
      return args[i + 1];
    }
    if (args[i].startsWith("--context=")) {
      return args[i].split("=")[1];
    }
  }

  // Use kubeconfig current-context
  try {
    const config = readKubeconfig();
    return config["current-context"] ?? null;
  } catch {
    return null;
  }
}

function findK8sConnection(connections: Connection[], contextName: string): Connection | null {
  // Exact match on connection name
  const exactMatch = connections.find((c) => c.name === contextName);
  if (exactMatch) return exactMatch;

  // Match on cluster_name in access_schema
  const clusterMatch = connections.find(
    (c) => c.access_schema?.cluster_name === contextName
  );
  if (clusterMatch) return clusterMatch;

  // Match on tags
  const tagMatch = connections.find(
    (c) => c.tags?.context === contextName || c.tags?.cluster === contextName
  );
  if (tagMatch) return tagMatch;

  // Partial match
  const partialMatch = connections.find(
    (c) => c.name.includes(contextName) || contextName.includes(c.name)
  );
  if (partialMatch) return partialMatch;

  return null;
}

function injectKubeconfig(apiUrl: string, token: string, contextName: string): void {
  // Use kubectl config commands to inject the proxy configuration
  const proxyUrl = `${apiUrl}/api/proxy/kubernetes`;

  // Set cluster server to Hoop proxy
  Bun.spawnSync(
    ["kubectl", "config", "set-cluster", `hsh-${contextName}`, `--server=${proxyUrl}`],
    { env: process.env as Record<string, string> }
  );

  // Set credentials with the session token
  Bun.spawnSync(
    ["kubectl", "config", "set-credentials", `hsh-${contextName}`, `--token=${token}`],
    { env: process.env as Record<string, string> }
  );

  // Set context to use hoop cluster and credentials
  Bun.spawnSync(
    [
      "kubectl", "config", "set-context", contextName,
      `--cluster=hsh-${contextName}`,
      `--user=hsh-${contextName}`,
    ],
    { env: process.env as Record<string, string> }
  );
}

export const kubectlPlugin: Plugin = {
  name: "kubectl",
  description: "Kubernetes access via Hoop gateway",
  wrappedCommand: "kubectl",

  async run(args: string[]): Promise<void> {
    // 1. Get the target context
    const contextName = getCurrentContext(args);
    if (!contextName) {
      warn("No kubectl context detected. Running kubectl directly.");
      return execKubectl(args);
    }

    // 2. Ensure authenticated
    const token = await ensureAuthenticated();
    const apiUrl = getApiUrl()!;

    // 3. Find the k8s connection
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

    spin.text = `Creating session for ${connection.name}...`;

    // 4. Create session → get proxy token
    let sessionToken: string;
    try {
      const session = await client.createSession({
        connection: connection.name,
        type: "exec",
      });
      sessionToken = session.id;
    } catch (err: unknown) {
      spin.fail("Failed to create session");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(1);
    }

    spin.text = "Configuring kubectl proxy...";

    // 5. Backup and inject kubeconfig
    backupKubeconfig();
    injectKubeconfig(apiUrl, sessionToken, contextName);

    spin.succeed(`Kubernetes access configured via Hoop (${connection.name})`);

    // 6. Execute kubectl with original args
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
