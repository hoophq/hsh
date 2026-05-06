import { isAuthenticated, getToken, clearToken } from "./store.ts";
import { clearAllCachedCredentials } from "./sessions.ts";
import { performOAuthLogin } from "./oauth.ts";
import { performLocalAuthLogin, reportSetupRequired } from "./local.ts";
import { getApiUrl } from "../config/store.ts";
import { error, warn } from "../ui/output.ts";
import { ExitCodes } from "../plugins/exit-codes.ts";
import { getPublicServerInfo } from "../api/serverinfo.ts";
import { ApiUnreachableError, formatApiError } from "../api/client.ts";
import chalk from "chalk";

/**
 * Thrown by `ensureAuthenticated()` and `forceReauthenticate()` when the
 * user does not have a usable session. Plugins (ssh, kubectl,
 * `hsh kubeconfig`) catch this and exit with a clear message + exit
 * code 77 (ExitCodes.AuthRequired) — they MUST NOT auto-launch the
 * browser, because the user is mid-`ssh`/`kubectl` invocation and a
 * surprise browser pop is the disruptive UX called out in ENG-359.
 *
 * The single legitimate path that does launch the browser is
 * `hsh login` (and `login()` below) — the user explicitly asked for it.
 */
export class AuthRequiredError extends Error {
  constructor(message = "Hoop session expired or missing") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/**
 * Returns the current valid bearer token. Throws AuthRequiredError if
 * no usable token is on disk.
 *
 * IMPORTANT: this no longer auto-launches the OAuth browser flow.
 * Callers (plugins) must catch AuthRequiredError and decide what to
 * do — typically `handleAuthRequiredAndExit()` (formats a clear
 * message, exits 77).
 *
 * The previous implementation called `performOAuthLogin()` here, which
 * surprised users in the middle of `ssh ...` / `kubectl ...` runs.
 * See ENG-359 for the rationale.
 */
export async function ensureAuthenticated(): Promise<string> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  if (isAuthenticated()) {
    return getToken()!;
  }

  throw new AuthRequiredError();
}

/**
 * Called from the 401 handler in plugin code AFTER the gateway has
 * already attempted a transparent refresh and given up (i.e. the
 * refresh token itself is dead). Clears local state and signals the
 * caller to exit — same contract as `ensureAuthenticated()` above.
 *
 * Pre-ENG-349/359 this used to auto-launch the OAuth browser. It no
 * longer does.
 */
export async function forceReauthenticate(): Promise<never> {
  clearToken();
  clearAllCachedCredentials();
  throw new AuthRequiredError("Hoop session expired (refresh token also expired)");
}

/**
 * Interactive `hsh login` — orchestrator that picks the right flow
 * based on the gateway's `auth_method`:
 *
 *   - "oidc"  → browser OAuth (existing behavior)
 *   - "local" → email/password prompt + POST /api/localauth/login
 *   - "saml"  → not yet supported; clear error
 *   - other   → unsupported method; clear error
 *
 * The pre-flight `/api/publicserverinfo` call also surfaces
 * `setup_required: true` for fresh single-tenant local-auth gateways
 * (no users registered yet), which would otherwise fail with an
 * opaque "user not found" 404 mid-prompt.
 *
 * If the publicserverinfo call itself fails (gateway down, wrong URL,
 * old gateway version that doesn't have the endpoint), we fall back
 * to the OIDC flow — this preserves backward compatibility with
 * gateways predating the publicserverinfo endpoint and matches the
 * existing failure mode users have today.
 */
export async function login(): Promise<void> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  let serverInfo: Awaited<ReturnType<typeof getPublicServerInfo>>;
  try {
    serverInfo = await getPublicServerInfo(apiUrl);
  } catch (err) {
    // Don't fail the whole login — fall back to the OIDC flow which
    // has its own error messaging for unreachable gateways. This
    // preserves backward compat with gateways that don't expose
    // `/api/publicserverinfo` (older versions) and avoids regressing
    // users currently using OIDC successfully.
    if (err instanceof ApiUnreachableError) {
      warn(`Could not detect auth method (${err.reason}); trying OIDC flow.`);
    } else {
      warn(`Could not detect auth method (${formatApiError(err)}); trying OIDC flow.`);
    }
    await performOAuthLogin();
    return;
  }

  if (serverInfo.authMethod === "local") {
    if (serverInfo.setupRequired) {
      reportSetupRequired(apiUrl);
    }
    await performLocalAuthLogin(apiUrl);
    return;
  }

  if (serverInfo.authMethod === "oidc") {
    await performOAuthLogin();
    return;
  }

  if (serverInfo.authMethod === "saml") {
    error("SAML authentication is not yet supported by hsh.");
    error("Use the Hoop web UI to obtain a token, then write it to ~/.hsh/auth.json manually.");
    process.exit(1);
  }

  error(`Unsupported auth method '${serverInfo.authMethod}' reported by the gateway.`);
  process.exit(1);
}

export function logout(): void {
  clearToken();
  clearAllCachedCredentials();
}

/**
 * Canonical "session is dead, please re-login" UX. Plugins call this
 * from their AuthRequiredError catch blocks.
 *
 * Both lines go to stderr (fd 2). Stdout is reserved for tools like
 * `hsh kubeconfig` whose stdout is captured by `$(hsh kubeconfig …)`
 * — leaking a chalk-yellow string into KUBECONFIG would be very bad.
 *
 * Single source of truth for the wording — keeps the message
 * consistent across ssh, kubectl, and the `hsh kubeconfig` command.
 */
export function handleAuthRequiredAndExit(): never {
  // Use console.error directly (not the warn() helper which writes to
  // stdout). The chalk styling is preserved because chalk autodetects
  // stderr's TTY status independently.
  console.error(chalk.yellow("⚠ Your Hoop session has expired."));
  error("Run `hsh login` to re-authenticate, then retry your command.");
  process.exit(ExitCodes.AuthRequired);
}
