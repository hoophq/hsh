import type { Plugin } from "./base.ts";
import { ensureAuthenticated, forceReauthenticate } from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { isAuthenticated } from "../auth/store.ts";
import { createClient, ApiUnreachableError, AuthExpiredError } from "../api/client.ts";
import { getCachedCredentials, cacheCredentials, clearCachedCredentials } from "../auth/sessions.ts";
import type { Connection, SSHCredentials, CredentialsResponse } from "../api/types.ts";
import { spinner, tokenBox, error, info, warn, dim } from "../ui/output.ts";
import { debug } from "../ui/log.ts";
import { spawn } from "child_process";
import { parseSshArgs, rewriteSshArgs } from "./ssh-args.ts";
import { formatAmbiguityWarning, matchConnection } from "./match.ts";
import { ExitCodes } from "./exit-codes.ts";

function isLocalAddress(host: string): boolean {
  return host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost" || host === "::";
}

/**
 * Compute the spawn descriptor for SSH passthrough. Pure function; the
 * contract for non-Hoop hosts is that this MUST equal what would happen if
 * the user had typed `ssh <argv>` directly:
 *
 *   - argv passed through 1:1 (no rewrite, no injection)
 *   - no env override (the child inherits hsh's env, which is the user's)
 *   - stdio inherited so prompts, pty, scp/sftp pipelines all work
 *   - no cwd override
 *
 * Exported so tests can lock the contract down without spawning a real
 * process. See tests/ssh-passthrough.test.ts.
 */
export function buildPassthroughSpawn(args: string[]): {
  cmd: string;
  args: string[];
  options: { stdio: "inherit" };
} {
  return { cmd: "ssh", args, options: { stdio: "inherit" } };
}

function passthrough(args: string[]): void {
  const desc = buildPassthroughSpawn(args);
  const child = spawn(desc.cmd, desc.args, desc.options);
  // Pass the child's exit code through verbatim so $? in the user's shell
  // reflects ssh's exit status (1, 124 timeout, 130 SIGINT, 255 disconnect, …).
  child.on("exit", (code) => process.exit(code ?? ExitCodes.Success));
  child.on("error", (err) => {
    error(`Failed to start ssh: ${err.message}`);
    process.exit(ExitCodes.GenericError);
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
    debug("cache", `ssh hit name=${connectionName} expire_at=${cached.expire_at}`);
    return { resp: cached, creds: cached.connection_credentials as SSHCredentials };
  }
  debug("cache", `ssh miss name=${connectionName}`);

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
      debug("auth", `ssh credential request rejected as expired; forcing re-auth name=${connectionName}`);
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
    debug("ssh", `argv parsed`, {
      argc: args.length,
      host: hostname,
      user: parsed.user,
      port: parsed.port,
    });
    if (!hostname) {
      debug("ssh", "no hostname in argv → passthrough");
      return passthrough(args);
    }

    const apiUrl = getApiUrl();
    if (!apiUrl || !isAuthenticated()) {
      debug("ssh", `passthrough: apiUrl=${apiUrl ?? "<unset>"} authenticated=${isAuthenticated()}`);
      return passthrough(args);
    }

    // Look up connection — on AuthExpired, re-auth and retry
    let token = await ensureAuthenticated();
    let client = createClient(apiUrl, token);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        warn(`Hoop API unreachable (${err.reason}); running ssh directly`);
        return passthrough(args);
      }
      if (err instanceof AuthExpiredError) {
        token = await forceReauthenticate();
        client = createClient(apiUrl, token);
        try {
          connections = await client.listConnections();
        } catch (retryErr) {
          if (retryErr instanceof ApiUnreachableError) {
            warn(`Hoop API unreachable (${retryErr.reason}); running ssh directly`);
          }
          return passthrough(args);
        }
      } else {
        return passthrough(args);
      }
    }

    const result = matchConnection(connections, hostname, "ssh");
    debug("match", "ssh", {
      target: hostname,
      level: result.level,
      winner: result.match?.name ?? null,
      candidates: result.candidates.map((c) => c.name),
      ambiguous: result.ambiguous,
    });
    if (!result.match) return passthrough(args);
    if (result.ambiguous) warn(formatAmbiguityWarning(hostname, result));
    const connection = result.match;

    // Get or reuse credentials
    const spin = spinner(`Connecting to ${connection.name} via Hoop...`);
    let creds: SSHCredentials;
    try {
      const result = await getCredentials(connection.name, apiUrl);

      if (result.resp.has_review && !result.resp.connection_credentials) {
        spin.warn("This connection requires approval");
        info(`Review ID: ${result.resp.review_id}`);
        info("Waiting for approval in the Hoop web UI...");
        // EX_TEMPFAIL — credentials weren't issued, the user must approve.
        // Scripts should treat this as 'try again later', NOT as success.
        process.exit(ExitCodes.ReviewPending);
      }

      creds = result.creds;
      if (!creds?.hostname) {
        throw new Error("No SSH credentials returned");
      }
    } catch (err: unknown) {
      if (err instanceof ApiUnreachableError) {
        spin.stop();
        warn(`Hoop API unreachable (${err.reason}); running ssh directly`);
        return passthrough(args);
      }
      spin.fail("Failed to create credentials");
      const msg = err && typeof err === "object" && "message" in err ? (err as { message: string }).message : String(err);
      error(msg);
      process.exit(ExitCodes.GenericError);
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
    // Pass ssh's exit code through verbatim so scripts see what they'd see
    // running ssh directly (1 generic, 124 timeout, 130 SIGINT, 255 disconnect).
    child.on("exit", (code) => process.exit(code ?? ExitCodes.Success));
    child.on("error", (err) => {
      error(`Failed to start ssh: ${err.message}`);
      process.exit(ExitCodes.GenericError);
    });
  },
};
