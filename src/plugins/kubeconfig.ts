import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { getHshDir } from "../config/store.ts";

/**
 * Ephemeral kubeconfig generator for the hsh kubectl plugin.
 *
 * We never modify `~/.kube/config`. Instead we render a self-contained
 * kubeconfig YAML at `~/.hsh/kube/<connection>.yaml` and set
 *
 *   KUBECONFIG=~/.hsh/kube/<connection>.yaml:<original-KUBECONFIG-or-default>
 *
 * for the spawned kubectl process only. kubectl merges files left-to-right
 * with first-wins precedence, so the Hoop entry shadows the user's
 * matching-named context for that process and that process only.
 *
 * Cleanup is tied to credential-cache lifecycle (see `auth/sessions.ts`)
 * plus an opportunistic mtime-based sweep for orphans.
 */

const KUBECONFIG_DIR = "kube";
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Same sanitiser as sessions.ts — keeps cache & kubeconfig filenames in lockstep.
function sanitize(connectionName: string): string {
  return connectionName.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getKubeconfigDir(): string {
  const dir = join(getHshDir(), KUBECONFIG_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function kubeconfigPath(connectionName: string): string {
  return join(getKubeconfigDir(), `${sanitize(connectionName)}.yaml`);
}

export interface KubeconfigSpec {
  /** Context name as kubectl will see it (matches user's `current-context`). */
  contextName: string;
  /** Hoop proxy URL (e.g. https://gw.hoop.dev:8443). */
  server: string;
  /** Bearer token for the proxy. */
  token: string;
  /**
   * Optional namespace to embed in the context. If omitted, kubectl defaults
   * to whatever the user passes via `-n` or the original context's namespace.
   */
  namespace?: string;
}

/**
 * Render a single-context kubeconfig YAML.
 *
 * The cluster/user names are namespaced with an `hsh-` prefix so that even
 * if some tool merges this file alongside the user's real config, the
 * cluster/user blocks won't collide. The CONTEXT name matches the user's
 * `current-context` exactly so first-wins precedence routes traffic through
 * Hoop.
 *
 * Pure function — exported for unit tests.
 */
export function renderKubeconfig(spec: KubeconfigSpec): string {
  const clusterName = `hsh-${spec.contextName}`;
  const userName = `hsh-${spec.contextName}`;

  const lines: string[] = [
    "apiVersion: v1",
    "kind: Config",
    `current-context: ${yamlString(spec.contextName)}`,
    "clusters:",
    `- name: ${yamlString(clusterName)}`,
    "  cluster:",
    `    server: ${yamlString(spec.server)}`,
    "    insecure-skip-tls-verify: true",
    "users:",
    `- name: ${yamlString(userName)}`,
    "  user:",
    `    token: ${yamlString(spec.token)}`,
    "contexts:",
    `- name: ${yamlString(spec.contextName)}`,
    "  context:",
    `    cluster: ${yamlString(clusterName)}`,
    `    user: ${yamlString(userName)}`,
  ];

  if (spec.namespace) {
    lines.push(`    namespace: ${yamlString(spec.namespace)}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * YAML-quote any string that might contain reserved characters or could be
 * interpreted as a non-string scalar. Cheap and safe for the values we emit.
 */
function yamlString(value: string): string {
  // Always double-quote and escape backslash + double-quote per YAML 1.2 §7.3.1.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Atomically write the kubeconfig for `connectionName`.
 * Returns the absolute path. Mode 0600.
 */
export function writeEphemeralKubeconfig(
  connectionName: string,
  spec: KubeconfigSpec,
): string {
  const final = kubeconfigPath(connectionName);
  const tmp = `${final}.${process.pid}.tmp`;
  writeFileSync(tmp, renderKubeconfig(spec), { mode: 0o600 });
  renameSync(tmp, final); // atomic on POSIX
  return final;
}

export function clearEphemeralKubeconfig(connectionName: string): void {
  const path = kubeconfigPath(connectionName);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

export function clearAllEphemeralKubeconfigs(): void {
  const dir = getKubeconfigDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".yaml")) {
      try {
        unlinkSync(join(dir, file));
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Remove kubeconfig files older than ORPHAN_TTL_MS. Safe to call on every
 * kubectl invocation; cheap because the directory is small.
 */
export function sweepOrphanKubeconfigs(now: number = Date.now()): void {
  const dir = getKubeconfigDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml")) continue;
    const path = join(dir, file);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > ORPHAN_TTL_MS) {
        unlinkSync(path);
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Build the KUBECONFIG env-var value to pass to the spawned kubectl process.
 * The Hoop kubeconfig is placed first so its context wins in the merge.
 *
 * Pure function — exported for unit tests.
 *
 * @param hshKubeconfig absolute path to the hsh-generated file
 * @param originalKubeconfig the user's existing KUBECONFIG env var (or undefined)
 */
export function buildKubeconfigEnv(
  hshKubeconfig: string,
  originalKubeconfig: string | undefined,
): string {
  if (!originalKubeconfig || originalKubeconfig.trim() === "") {
    return hshKubeconfig;
  }
  // Avoid duplicating the hsh path if it somehow already appears.
  const parts = originalKubeconfig.split(":").filter((p) => p && p !== hshKubeconfig);
  return [hshKubeconfig, ...parts].join(":");
}
