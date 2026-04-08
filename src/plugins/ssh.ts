import type { Plugin } from "./base.ts";
import { ensureAuthenticated } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { isAuthenticated } from "../auth/store.ts";
import { createClient } from "../api/client.ts";
import type { Connection, SSHCredentials } from "../api/types.ts";
import { spinner, tokenBox, error, info, dim } from "../ui/output.ts";
import { spawn } from "child_process";

/**
 * Extracts the destination hostname from SSH args without consuming them.
 * Returns null if no hostname found (e.g. `ssh -V`).
 * Does NOT modify the args array — we pass all original args through.
 */
function extractHostname(args: string[]): string | null {
  const flagsWithValues = new Set([
    "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
    "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
  ]);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      // Everything after -- is the remote command
      break;
    }

    if (arg.startsWith("-")) {
      // Skip flags that consume the next arg
      if (flagsWithValues.has(arg)) {
        i++;
      }
      continue;
    }

    // First positional arg is the destination
    const hostname = arg.includes("@") ? arg.split("@").pop()! : arg;
    return hostname;
  }

  return null;
}

/**
 * Rewrites SSH args: replaces the original destination with gateway credentials
 * and injects gateway port. Preserves ALL other args (flags, port forwards,
 * remote commands, etc.)
 */
function rewriteArgs(
  originalArgs: string[],
  creds: SSHCredentials,
  gatewayHost: string,
): string[] {
  const flagsWithValues = new Set([
    "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
    "-L", "-l", "-m", "-O", "-o", "-Q", "-R", "-S", "-W", "-w",
  ]);

  const result: string[] = [];
  let destinationReplaced = false;
  let portReplaced = false;

  for (let i = 0; i < originalArgs.length; i++) {
    const arg = originalArgs[i];

    if (arg === "--") {
      // Pass through -- and everything after it (remote command)
      result.push(...originalArgs.slice(i));
      break;
    }

    if (arg === "-p" && i + 1 < originalArgs.length) {
      // Replace original port with gateway port
      result.push("-p", creds.port);
      portReplaced = true;
      i++;
      continue;
    }

    if (arg === "-l" && i + 1 < originalArgs.length) {
      // Drop -l user — we set user via user@host
      i++;
      continue;
    }

    if (arg.startsWith("-")) {
      result.push(arg);
      if (flagsWithValues.has(arg) && i + 1 < originalArgs.length) {
        result.push(originalArgs[++i]);
      }
      continue;
    }

    if (!destinationReplaced) {
      // Replace the destination with gateway credentials
      result.push(`${creds.username}@${gatewayHost}`);
      destinationReplaced = true;
      continue;
    }

    // Additional positional args (remote command without --)
    result.push(arg);
  }

  // Inject -p if the original command didn't have it
  if (!portReplaced) {
    result.unshift("-p", creds.port);
  }

  return result;
}

function findConnection(connections: Connection[], hostname: string): Connection | null {
  // Exact match on connection name
  const exact = connections.find(
    (c) => c.name === hostname || c.name === hostname.split(".")[0]
  );
  if (exact) return exact;

  // Match on access_schema
  const byHost = connections.find((c) => c.access_schema?.ssh_host === hostname);
  if (byHost) return byHost;

  // Match on tags
  const byTag = connections.find(
    (c) => c.tags?.hostname === hostname || c.tags?.host === hostname
  );
  if (byTag) return byTag;

  // Partial match
  const partial = connections.find(
    (c) => c.name.includes(hostname) || hostname.includes(c.name)
  );
  if (partial) return partial;

  return null;
}

function isLocalAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost" || host === "::";
}

/** Pass through to native ssh — no Hoop involved */
function passthrough(args: string[]): void {
  const child = spawn("ssh", args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    error(`Failed to start ssh: ${err.message}`);
    process.exit(1);
  });
}

export const sshPlugin: Plugin = {
  name: "ssh",
  description: "SSH connections via Hoop gateway",
  wrappedCommand: "ssh",

  async run(args: string[]): Promise<void> {
    // 1. Extract hostname — if none (e.g. `ssh -V`), pass through
    const hostname = extractHostname(args);
    if (!hostname) {
      return passthrough(args);
    }

    // 2. If not authenticated or no API URL configured, pass through
    const apiUrl = getApiUrl();
    if (!apiUrl || !isAuthenticated()) {
      return passthrough(args);
    }

    // 3. Look up connection — if not found in Hoop, pass through to native ssh
    const token = await ensureAuthenticated();
    const client = createClient(apiUrl, token);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch {
      // API unreachable — don't block the user, pass through
      return passthrough(args);
    }

    const connection = findConnection(connections, hostname);
    if (!connection) {
      return passthrough(args);
    }

    // 4. Create credentials
    const spin = spinner(`Connecting to ${connection.name} via Hoop...`);
    let creds: SSHCredentials;
    try {
      const resp = await client.createCredentials(connection.name);

      if (resp.has_review && !resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${resp.review_id}`);
        info("Waiting for approval in the Hoop web UI...");
        process.exit(0);
      }

      creds = resp.connection_credentials as SSHCredentials;
      if (!creds?.hostname) {
        throw new Error("No SSH credentials returned");
      }
    } catch (err: unknown) {
      spin.fail("Failed to create credentials");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(1);
    }

    spin.succeed(`Credentials created for ${connection.name}`);

    // 5. Resolve gateway host
    const gatewayHost = isLocalAddress(creds.hostname)
      ? new URL(apiUrl).hostname
      : creds.hostname;

    // 6. Display token
    tokenBox({
      title: "Hoop SSH Access",
      connection: connection.name,
      token: creds.password,
      instructions: "Use the password above when prompted",
    });

    // 7. Rewrite SSH args: replace destination + port, keep everything else
    const sshArgs = rewriteArgs(args, creds, gatewayHost);

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
