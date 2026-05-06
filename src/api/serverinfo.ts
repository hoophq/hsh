import { fetchWithTimeout, formatApiError } from "./client.ts";

/**
 * Hoop gateway's public server info. Unauthenticated — anyone can hit
 * `GET /api/publicserverinfo` to learn what auth method is configured.
 *
 * Source of truth: hoophq/hoop `gateway/api/openapi/types.go`
 * (`PublicServerInfo`) and `gateway/api/publicserverinfo/publicserverinfo.go`.
 *
 * `auth_method` enum values are pinned to what the gateway emits today:
 *   - "local"  → email/password via `POST /api/localauth/login`
 *   - "oidc"   → browser OAuth via `GET /api/login`
 *   - "saml"   → SAML SSO (not yet supported by hsh)
 *
 * `setup_required` is true when the gateway is single-tenant and has no
 * users yet — i.e. the very first admin still needs to register via
 * `POST /api/localauth/register`. We surface this in error messages so
 * a fresh local-auth gateway gives the user something actionable.
 */
export type AuthMethod = "local" | "oidc" | "saml";

export interface ServerInfo {
  authMethod: AuthMethod | string;
  setupRequired: boolean;
}

/**
 * Slightly more generous than the 3s default — the user is mid-login
 * and waiting for this single call before the rest of the flow proceeds.
 * Same value as the existing OIDC login URL fetch.
 */
const PUBLICSERVERINFO_TIMEOUT_MS = 10_000;

/**
 * Fetch and validate the gateway's public server info. The endpoint is
 * unauthenticated (no Authorization header), so this works pre-login.
 *
 * Throws on transport failure, non-2xx, or malformed JSON. Callers
 * (the login orchestrator) translate the error into a user-friendly
 * message — this layer just propagates.
 */
export async function getPublicServerInfo(apiUrl: string): Promise<ServerInfo> {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/publicserverinfo`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs: PUBLICSERVERINFO_TIMEOUT_MS,
    });
  } catch (err) {
    // fetchWithTimeout already wraps network errors as ApiUnreachableError.
    throw err;
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      // ignore — keep the status line
    }
    throw new Error(`failed to fetch /api/publicserverinfo: ${detail}`);
  }

  // Tolerate extra fields and missing optional fields. The two we care
  // about have explicit defaults so a partial response still yields a
  // usable ServerInfo (auth_method = "" → orchestrator falls into the
  // "unsupported" branch, which is the right behavior).
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`malformed /api/publicserverinfo response: ${formatApiError(err)}`);
  }

  if (typeof body !== "object" || body === null) {
    throw new Error("malformed /api/publicserverinfo response: not an object");
  }

  const obj = body as Record<string, unknown>;
  const authMethod = typeof obj.auth_method === "string" ? obj.auth_method : "";
  const setupRequired = obj.setup_required === true;
  return { authMethod, setupRequired };
}
