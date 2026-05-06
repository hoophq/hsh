import { isAuthenticated, getToken, clearToken } from "./store.ts";
import { clearAllCachedCredentials } from "./sessions.ts";
import { performOAuthLogin } from "./oauth.ts";
import { getApiUrl } from "../config/store.ts";
import { error } from "../ui/output.ts";
import { ExitCodes } from "../plugins/exit-codes.ts";
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
 * Interactive `hsh login` — the ONE place that launches the browser
 * automatically. Unchanged from previous behavior.
 */
export async function login(): Promise<void> {
  await performOAuthLogin();
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
