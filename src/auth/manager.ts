import { isAuthenticated, getToken, clearToken } from "./store.ts";
import { clearAllCachedCredentials } from "./sessions.ts";
import { performOAuthLogin } from "./oauth.ts";
import { getApiUrl } from "../config/store.ts";
import { error, info } from "../ui/output.ts";

export async function ensureAuthenticated(): Promise<string> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  if (isAuthenticated()) {
    return getToken()!;
  }

  info("Session expired. Re-authenticating...");
  await performOAuthLogin();

  const token = getToken();
  if (!token) {
    error("Authentication failed. Please try again.");
    process.exit(1);
  }

  return token;
}

/** Force a new login, clearing old tokens and cached sessions */
export async function forceReauthenticate(): Promise<string> {
  clearToken();
  clearAllCachedCredentials();
  return ensureAuthenticated();
}

export async function login(): Promise<void> {
  await performOAuthLogin();
}

export function logout(): void {
  clearToken();
  clearAllCachedCredentials();
}
