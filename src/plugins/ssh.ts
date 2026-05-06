import type { Plugin } from "./base.ts";
import { ensureAuthenticated, forceReauthenticate } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { isAuthenticated } from "../auth/store.ts";
import { createClient, AuthExpiredError } from "../api/client.ts";
import { getCachedCredentials, cacheCredentials, clearCachedCredentials } from "../auth/sessions.ts";
import type { Connection, SSHCredentials, CredentialsResponse } from "../api/types.ts";
import { spinner, tokenBox, error, info, dim } from "../ui/output.ts";
import { spawn } from "child_process";
import { parseSshArgs, rewriteSshArgs } from "./ssh-args.ts";

function findConnection(connections: Connection[], hostname: string): Connection | null {
  const exact = connections.find(
    (c) => c.name === hostname || c.name === hostname.split(".")[0]
  );
  if (exact) return exact;

  const byHost = connections.find((c) => c.access_schema?.ssh_host === hostname);
  if (byHost) return byHost;

  const byTag = connections.find(
    (c) => c.tags?.hostname === hostname || c.tags?.host === hostname
  );
  if (byTag) return byTag;

  const partial = connections.find(
    (c) => c.name.includes(hostname) || hostname.includes(c.name)
  );
  if (partial) return partial;

  return null;
}

function isLocalAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost" || host === "::";
}

function passthrough(args: string[]): void {
  const child = spawn("ssh", args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    error(`Failed to start ssh: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Get or create credentials for a connection.
 * Returns cached credentials if they're still valid, otherwise creates new ones.
 * On 401, forces re-auth and retries once.
 */
async function getCredentials(
  connectionName: string,
  apiUrl: string,
  retried = false,
): Promise<{ resp: CredentialsResponse; creds: SSHCredentials }> {
  // Check cache first
  const cached = getCachedCredentials(connectionName);
  if (cached?.connection_credentials) {
    return { resp: cached, creds: cached.connection_credentials as SSHCredentials };
  }

  const token = await ensureAuthenticated();
  const client = createClient(apiUrl, token);

  try {
    const resp = await client.createCredentials(connectionName);
    if (resp.connection_credentials) {
      cacheCredentials(connectionName, resp);
    }
    return { resp, creds: resp.connection_credentials as SSHCredentials };
  } catch (err) {
    if (err instanceof AuthExpiredError && !retried) {
      // Token expired server-side — force re-auth and retry
      clearCachedCredentials(connectionName);
      await forceReauthenticate();
      return getCredentials(connectionName, apiUrl, true);
    }
    throw err;
  }
}

export const sshPlugin: Plugin = {
  name: "ssh",
  description: "SSH connections via Hoop gateway",
  wrappedCommand: "ssh",

  async run(args: string[]): Promise<void> {
    const parsed = parseSshArgs(args);
    const hostname = parsed.host;
    if (!hostname) return passthrough(args);

    const apiUrl = getApiUrl();
    if (!apiUrl || !isAuthenticated()) return passthrough(args);

    // Look up connection — on AuthExpired, re-auth and retry
    let token = await ensureAuthenticated();
    let client = createClient(apiUrl, token);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        token = await forceReauthenticate();
        client = createClient(apiUrl, token);
        try {
          connections = await client.listConnections();
        } catch {
          return passthrough(args);
        }
      } else {
        return passthrough(args);
      }
    }

    const connection = findConnection(connections, hostname);
    if (!connection) return passthrough(args);

    // Get or reuse credentials
    const spin = spinner(`Connecting to ${connection.name} via Hoop...`);
    let creds: SSHCredentials;
    try {
      const result = await getCredentials(connection.name, apiUrl);

      if (result.resp.has_review && !result.resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${result.resp.review_id}`);
        info("Waiting for approval in the Hoop web UI...");
        process.exit(0);
      }

      creds = result.creds;
      if (!creds?.hostname) {
        throw new Error("No SSH credentials returned");
      }
    } catch (err: unknown) {
      spin.fail("Failed to create credentials");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(1);
    }

    const cached = getCachedCredentials(connection.name);
    if (cached) {
      const expires = new Date(cached.expire_at);
      const mins = Math.round((expires.getTime() - Date.now()) / 60_000);
      spin.succeed(`Using active session for ${connection.name} (expires in ${mins}m)`);
    } else {
      spin.succeed(`Credentials created for ${connection.name}`);
    }

    const gatewayHost = isLocalAddress(creds.hostname)
      ? new URL(apiUrl).hostname
      : creds.hostname;

    tokenBox({
      title: "Hoop SSH Access",
      connection: connection.name,
      token: creds.password,
      instructions: "Use the password above when prompted",
    });

    const sshArgs = rewriteSshArgs(parsed, {
      newUser: creds.username,
      newHost: gatewayHost,
      newPort: creds.port,
    });

    info(`Connecting: ssh ${sshArgs.join(" ")}`);
    console.log();

    const child = spawn("ssh", sshArgs, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      error(`Failed to start ssh: ${err.message}`);
      process.exit(1);
    });
  },
};
