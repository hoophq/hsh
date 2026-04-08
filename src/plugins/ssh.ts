import type { Plugin } from "./base.ts";
import { ensureAuthenticated } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { createClient } from "../api/client.ts";
import type { Connection } from "../api/types.ts";
import { spinner, tokenBox, error, info, warn, dim } from "../ui/output.ts";
import { spawn } from "child_process";

interface ParsedSshArgs {
  hostname: string;
  user?: string;
  port?: string;
  rest: string[];
}

function parseSshArgs(args: string[]): ParsedSshArgs | null {
  let hostname: string | undefined;
  let user: string | undefined;
  let port: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-p" && i + 1 < args.length) {
      port = args[++i];
    } else if (arg === "-l" && i + 1 < args.length) {
      user = args[++i];
    } else if (arg.startsWith("-")) {
      // Skip flags with values
      const flagsWithValues = ["-o", "-i", "-F", "-J", "-L", "-R", "-D", "-W", "-b", "-c", "-E", "-e", "-m", "-S", "-w"];
      if (flagsWithValues.includes(arg) && i + 1 < args.length) {
        rest.push(arg, args[++i]);
      } else {
        rest.push(arg);
      }
    } else if (!hostname) {
      // First non-flag argument is the destination
      if (arg.includes("@")) {
        const parts = arg.split("@");
        user = parts[0];
        hostname = parts[1];
      } else {
        hostname = arg;
      }
    } else {
      // Remaining args (remote command)
      rest.push(arg);
    }
  }

  if (!hostname) return null;
  return { hostname, user, port, rest };
}

function findConnectionByHostname(connections: Connection[], hostname: string): Connection | null {
  // Exact match on connection name
  const exactMatch = connections.find(
    (c) => c.name === hostname || c.name === hostname.split(".")[0]
  );
  if (exactMatch) return exactMatch;

  // Match on access_schema.ssh_host
  const hostMatch = connections.find(
    (c) => c.access_schema?.ssh_host === hostname
  );
  if (hostMatch) return hostMatch;

  // Match on tags
  const tagMatch = connections.find(
    (c) => c.tags?.hostname === hostname || c.tags?.host === hostname
  );
  if (tagMatch) return tagMatch;

  // Partial match on connection name
  const partialMatch = connections.find(
    (c) => c.name.includes(hostname) || hostname.includes(c.name)
  );
  if (partialMatch) return partialMatch;

  return null;
}

export const sshPlugin: Plugin = {
  name: "ssh",
  description: "SSH connections via Hoop gateway",
  wrappedCommand: "ssh",

  async run(args: string[]): Promise<void> {
    const parsed = parseSshArgs(args);
    if (!parsed) {
      error("Could not parse SSH destination from arguments.");
      info("Usage: ssh [user@]hostname");
      process.exit(1);
    }

    const { hostname, user } = parsed;

    // 1. Ensure authenticated
    const token = await ensureAuthenticated();
    const apiUrl = getApiUrl()!;

    // 2. Find the connection
    const spin = spinner(`Looking up connection for ${hostname}...`);
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

    const connection = findConnectionByHostname(connections, hostname);
    if (!connection) {
      spin.fail(`No Hoop connection found for: ${hostname}`);
      info("Available connections:");
      for (const c of connections.slice(0, 10)) {
        dim(`  ${c.name} (${c.type})`);
      }
      if (connections.length > 10) {
        dim(`  ... and ${connections.length - 10} more`);
      }
      process.exit(1);
    }

    spin.text = `Creating session for ${connection.name}...`;

    // 3. Create session → get access token
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

    spin.succeed(`Session created for ${connection.name}`);

    // 4. Display token
    tokenBox({
      title: "Hoop SSH Access",
      connection: connection.name,
      token: sessionToken,
      instructions: "Copy this token and paste when prompted by the gateway",
    });

    // 5. Determine gateway host from API URL
    const gatewayHost = new URL(apiUrl).hostname;
    const sshTarget = user ? `${user}@${gatewayHost}` : gatewayHost;

    info(`Connecting to gateway: ${gatewayHost}`);
    console.log();

    // 6. Execute SSH to gateway
    const sshArgs = [sshTarget];
    if (parsed.port) {
      sshArgs.push("-p", parsed.port);
    }

    const child = spawn("ssh", sshArgs, {
      stdio: "inherit",
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });

    child.on("error", (err) => {
      error(`Failed to start SSH: ${err.message}`);
      process.exit(1);
    });
  },
};
