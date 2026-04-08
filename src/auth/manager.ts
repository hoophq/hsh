import { isAuthenticated, getToken, clearToken } from "./store.ts";
import { performOAuthLogin } from "./oauth.ts";
import { getApiUrl } from "../config/store.ts";
import { error } from "../ui/output.ts";

export async function ensureAuthenticated(): Promise<string> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  if (isAuthenticated()) {
    return getToken()!;
  }

  await performOAuthLogin();

  const token = getToken();
  if (!token) {
    error("Authentication failed. Please try again.");
    process.exit(1);
  }

  return token;
}

export async function login(): Promise<void> {
  await performOAuthLogin();
}

export function logout(): void {
  clearToken();
}
