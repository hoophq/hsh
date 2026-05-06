import type { Plugin } from "./base.ts";
import {
  ensureAuthenticated,
  forceReauthenticate,
  AuthRequiredError,
  handleAuthRequiredAndExit,
} from "../auth/manager.ts";
import { getApiUrl } from "../config/store.ts";
import { isAuthenticated } from "../auth/store.ts";
import { createClient, ApiUnreachableError, AuthExpiredError, formatApiError } from "../api/client.ts";
import { getCachedCredentials, cacheCredentials, clearCachedCredentials } from "../auth/sessions.ts";
import type { Connection, SSHCredentials, CredentialsResponse } from "../api/types.ts";
import { spinner, tokenBox, error, info, warn, dim } from "../ui/output.ts";
import { debug } from "../ui/log.ts";
import { spawn } from "child_process";
import { parseSshArgs, rewriteSshArgs } from "./ssh-args.ts";
import { formatAmbiguityWarning, matchConnection } from "./match.ts";
import { ExitCodes } from "./exit-codes.ts";
import {
  cleanupAskpassPair,
  isAskpassEnabled,
  supportsAskpassRequireForce,
  sweepOrphanAskpass,
  withAskpassEnv,
  writeAskpassPair,
  type AskpassPair,
} from "../auth/askpass.ts";

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
      // Gateway returned 401 — with the X-New-Access-Token transparent
      // refresh path (ENG-349), this means the server-side refresh
      // token itself is dead. forceReauthenticate() now throws
      // AuthRequiredError instead of auto-launching the browser; let
      // it bubble up to the run() wrapper which prints the canonical
      // "session expired, run hsh login" message and exits 77.
      debug("auth", `ssh credential request rejected; refresh token also expired name=${connectionName}`);
      clearCachedCredentials(connectionName);
      await forceReauthenticate(); // never returns — throws AuthRequiredError
    }
    throw err;
  }
}

export const sshPlugin: Plugin = {
  name: "ssh",
  description: "SSH connections via Hoop gateway",
  wrappedCommand: "ssh",

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

    // Look up connection. ensureAuthenticated() throws AuthRequiredError
    // if no usable token is on disk; in that case fall through to
    // native ssh (the user might be ssh'ing somewhere unrelated to
    // Hoop and shouldn't be forced to log in just for `ssh github.com`).
    // The same passthrough policy is used for ApiUnreachableError.
    let token: string;
    try {
      token = await ensureAuthenticated();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        debug("ssh", "no Hoop session; running ssh directly");
        return passthrough(args);
      }
      throw err;
    }
    const client = createClient(apiUrl, token);

    let connections: Connection[];
    try {
      connections = await client.listConnections();
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        warn(`Hoop API unreachable (${err.reason}); running ssh directly`);
        return passthrough(args);
      }
      if (err instanceof AuthExpiredError) {
        // Gateway gave up on transparent refresh — refresh token is
        // dead. Force a clean exit with the canonical "session expired"
        // UX (caught by run() wrapper). We don't passthrough here:
        // if the user *had* a Hoop session, ssh'ing past the gateway
        // would yield a confusing auth error rather than an actionable
        // "run hsh login" message.
        await forceReauthenticate(); // throws AuthRequiredError
      }
      return passthrough(args);
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
      error(formatApiError(err));
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

    const sshArgs = rewriteSshArgs(parsed, {
      newUser: creds.username,
      newHost: gatewayHost,
      newPort: creds.port,
    });

    // ENG-360: try askpass-based auto-injection. Falls back to the
    // copy/paste UX (legacy `tokenBox`) when:
    //   - HSH_SSH_ASKPASS=0/off/false/no  (per-invocation kill switch)
    //   - OpenSSH < 8.4 doesn't honor SSH_ASKPASS_REQUIRE=force
    //   - ssh isn't installed (ENOENT from `ssh -V`) — though if we
    //     made it this far we'd already have failed somewhere upstream
    //
    // Sweep first so a crashed earlier `hsh ssh` doesn't leak files
    // forever. Cheap (5-min TTL on a tiny per-user dir).
    sweepOrphanAskpass();

    const useAskpass = isAskpassEnabled() && supportsAskpassRequireForce();
    debug("ssh", `askpass useAskpass=${useAskpass} enabled=${isAskpassEnabled()}`);

    if (useAskpass) {
      runWithAskpass({
        spin,
        connectionName: connection.name,
        sshArgs,
        token: creds.password,
      });
      return;
    }

    runWithCopyPaste({
      spin,
      connectionName: connection.name,
      sshArgs,
      token: creds.password,
    });
}

interface RunArgs {
  spin: ReturnType<typeof spinner>;
  connectionName: string;
  sshArgs: string[];
  token: string;
}

/**
 * ENG-360 path: write askpass pair, spawn ssh with SSH_ASKPASS env vars,
 * always cleanup in finally (success OR failure OR exception).
 *
 * Note: we exit the process via `process.exit(code)` inside the child's
 * exit handler, so the cleanup happens BEFORE that exit() call. We
 * cannot rely on `finally` outside the spawn — it would never run
 * because process.exit short-circuits anything else.
 */
function runWithAskpass(args: RunArgs): void {
  let pair: AskpassPair;
  try {
    pair = writeAskpassPair(args.token);
  } catch (err) {
    // Disk full, permission denied on ~/.hsh/askpass/, etc. Fall back
    // to copy/paste rather than failing the whole `hsh ssh` invocation.
    warn(
      `askpass setup failed (${err instanceof Error ? err.message : String(err)}); ` +
        "falling back to copy/paste.",
    );
    runWithCopyPaste(args);
    return;
  }

  info(`Connecting: ssh ${args.sshArgs.join(" ")}`);
  // Soft hint that the user shouldn't paste anything; quiet enough to
  // not be noisy after the novelty wears off.
  dim("(token will be injected automatically)");
  console.log();

  const child = spawn("ssh", args.sshArgs, {
    stdio: "inherit",
    env: withAskpassEnv(process.env, pair.shimPath),
  });

  // Cleanup on EITHER exit OR error path. We don't want to leave
  // tempfiles on disk, even though the sweeper would catch them in
  // 5 minutes — that's the failsafe, not the primary mechanism.
  child.on("exit", (code) => {
    cleanupAskpassPair(pair);
    process.exit(code ?? ExitCodes.Success);
  });
  child.on("error", (err) => {
    cleanupAskpassPair(pair);
    error(`Failed to start ssh: ${err.message}`);
    process.exit(ExitCodes.GenericError);
  });
}

/**
 * Legacy path (pre-ENG-360 UX). Kept for users on OpenSSH < 8.4 and as
 * the kill switch when `HSH_SSH_ASKPASS=0`.
 *
 * NOTE: a future iteration could shorten the box and switch the copy
 * to "Press Enter then paste" once we're confident the askpass path
 * is the default UX. Until then, the legacy box is verbatim what
 * users have been seeing for months.
 */
function runWithCopyPaste(args: RunArgs): void {
  tokenBox({
    title: "Hoop SSH Access",
    connection: args.connectionName,
    token: args.token,
    // Action-oriented copy: tells the user what to DO, not what the
    // token IS. Updated as part of ENG-360 — for users who land on
    // this path (OpenSSH < 8.4 or HSH_SSH_ASKPASS=0), the new copy
    // matches what the spike doc recommended.
    instructions: "Press Enter at the password prompt, then paste this token.",
  });

  info(`Connecting: ssh ${args.sshArgs.join(" ")}`);
  console.log();

  const child = spawn("ssh", args.sshArgs, { stdio: "inherit" });
  // Pass ssh's exit code through verbatim so scripts see what they'd see
  // running ssh directly (1 generic, 124 timeout, 130 SIGINT, 255 disconnect).
  child.on("exit", (code) => process.exit(code ?? ExitCodes.Success));
  child.on("error", (err) => {
    error(`Failed to start ssh: ${err.message}`);
    process.exit(ExitCodes.GenericError);
  });
}
