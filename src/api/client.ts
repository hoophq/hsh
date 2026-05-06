import { debug } from "../ui/log.ts";
import { saveTokenFromJwt } from "../auth/store.ts";
import type { Connection, CredentialsRequest, CredentialsResponse, ApiError } from "./types.ts";

/**
 * Header used by the Hoop gateway to silently rotate an expired (but
 * signature-valid) JWT. The gateway's auth middleware refreshes the
 * server-side OIDC refresh token and writes the new access token here
 * on every response — see hoophq/hoop PR #1415 (gateway/api/apiroutes/auth.go).
 *
 * Lower-cased because Headers.get() is case-insensitive in practice but
 * we want to be explicit. Both casings ("X-New-Access-Token" and
 * "x-new-access-token") arrive interchangeably depending on HTTP/1.1
 * vs HTTP/2 and intermediate proxies; Headers.get() handles that.
 */
export const NEW_ACCESS_TOKEN_HEADER = "x-new-access-token";

/**
 * Default request timeout. Per the PRD ("fail open to native commands with
 * a clear warning, not block the user's terminal. The timeout should be
 * short — 2-3 seconds max"). Picked 3000ms.
 */
export const DEFAULT_API_TIMEOUT_MS = 3000;

export class AuthExpiredError extends Error {
  constructor() {
    super("Authentication expired");
    this.name = "AuthExpiredError";
  }
}

/**
 * The Hoop API is unreachable (timeout, DNS failure, refused connection,
 * connection reset, etc.). Callers should warn the user and fall through
 * to native passthrough rather than blocking the terminal.
 */
export class ApiUnreachableError extends Error {
  /** Human-friendly reason for logging ("timeout", "DNS failure", etc.). */
  readonly reason: string;
  /** The original error or response that caused the failure (for HSH_DEBUG). */
  readonly cause?: unknown;

  constructor(reason: string, cause?: unknown) {
    super(`Hoop API unreachable: ${reason}`);
    this.name = "ApiUnreachableError";
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Best-effort classifier for network errors. We only need to distinguish
 * "looks like the network is down" from "the API responded but something
 * was wrong with our request" (the latter is handled by HTTP status codes).
 */
function classifyFetchError(err: unknown): ApiUnreachableError {
  // Timeout: Bun throws a DOMException (name: "TimeoutError") for
  // AbortSignal.timeout(); Node throws a plain Error (name: "AbortError")
  // for AbortController.abort(). Cover both.
  if (err && typeof err === "object" && "name" in err) {
    const n = (err as { name: unknown }).name;
    if (n === "AbortError" || n === "TimeoutError") {
      return new ApiUnreachableError("timeout", err);
    }
  }
  // Network errors expose codes via `err.code` (Node + Bun both). Bun uses
  // PascalCase ("ConnectionRefused"), Node uses POSIX-style ("ECONNREFUSED").
  // We accept both. Fall back to `err.cause.code` since Node's undici wraps
  // the underlying SystemError.
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    const causeCode =
      err.cause && typeof err.cause === "object" && err.cause !== null
        ? (err.cause as { code?: string }).code
        : undefined;
    const c = code ?? causeCode;
    if (
      c === "ENOTFOUND" ||
      c === "EAI_AGAIN" ||
      c === "DNSNotFound" ||
      c === "UnableToResolveHost"
    ) {
      return new ApiUnreachableError("DNS failure", err);
    }
    if (c === "ECONNREFUSED" || c === "ConnectionRefused") {
      return new ApiUnreachableError("connection refused", err);
    }
    if (c === "ECONNRESET" || c === "EPIPE" || c === "ConnectionClosed") {
      return new ApiUnreachableError("connection reset", err);
    }
    if (c === "ETIMEDOUT" || c === "ConnectTimeout") {
      return new ApiUnreachableError("timeout", err);
    }
    // Generic "network error" bucket — still passthrough-eligible.
    return new ApiUnreachableError(err.message || "network error", err);
  }
  return new ApiUnreachableError("network error", err);
}

interface RequestOptions extends Omit<RequestInit, "signal"> {
  /** Override the default 3s timeout. Pass 0 to disable. */
  timeoutMs?: number;
}

/**
 * Shared `fetch` wrapper with timeout + network-error classification.
 * Used by both the authenticated client and the unauthenticated OAuth
 * flow so we have one consistent failure model.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, ...rest } = options;
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  // Log the URL (no headers — they carry the bearer token).
  debug("api", `fetch ${rest.method ?? "GET"} ${url} timeoutMs=${timeoutMs}`);
  try {
    const res = await fetch(url, { ...rest, signal });
    debug("api", `response ${res.status} ${url}`);
    return res;
  } catch (err) {
    const classified = classifyFetchError(err);
    debug("api", `fetch failed ${url} reason=${classified.reason}`);
    throw classified;
  }
}

/**
 * Hook called when the gateway returns a refreshed access token via
 * the X-New-Access-Token response header. Default behavior is to
 * persist it to auth.json (atomic write). Tests inject a stub.
 */
export type TokenRefreshHandler = (newToken: string) => void;

const defaultTokenRefreshHandler: TokenRefreshHandler = (newToken) => {
  // saveTokenFromJwt decodes the JWT to extract the new exp/email and
  // writes via the same atomic-write path used by the OAuth login flow.
  saveTokenFromJwt(newToken);
};

export class HoopApiClient {
  private apiUrl: string;
  /**
   * The bearer token. MUTABLE — the gateway can hand us a fresh token
   * via the X-New-Access-Token header at any point during a request,
   * and subsequent requests from the same client instance must use
   * the rotated value (otherwise they'd race the next refresh).
   */
  private token: string;
  private onTokenRefreshed: TokenRefreshHandler;

  constructor(apiUrl: string, token: string, onTokenRefreshed?: TokenRefreshHandler) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
    this.onTokenRefreshed = onTokenRefreshed ?? defaultTokenRefreshHandler;
  }

  /** Current bearer token (post any X-New-Access-Token rotations). */
  getToken(): string {
    return this.token;
  }

  /**
   * Inspect a response for the X-New-Access-Token header and, if
   * present, rotate the in-memory token + persist it via the handler.
   * Safe to call on every response (no-op when header is absent).
   *
   * Validation: header must be a non-empty string with three
   * dot-separated segments (rough JWT shape). A malformed value is
   * logged via debug() and ignored — better to keep using the stale
   * but parseable token than to corrupt auth.json.
   */
  private maybeRotateToken(response: Response): void {
    const next = response.headers.get(NEW_ACCESS_TOKEN_HEADER);
    if (!next) return;

    const trimmed = next.trim();
    if (!trimmed) {
      debug("auth", "X-New-Access-Token header was empty; ignoring");
      return;
    }
    // Cheap shape check — full verification happens server-side on
    // the next request. We just want to avoid persisting obvious junk.
    if (trimmed.split(".").length !== 3) {
      debug("auth", "X-New-Access-Token header not in JWT shape; ignoring");
      return;
    }
    if (trimmed === this.token) {
      // Server echoed the same token (shouldn't happen, but harmless).
      return;
    }

    debug("auth", "X-New-Access-Token received; rotating in-memory + persisting");
    this.token = trimmed;
    try {
      this.onTokenRefreshed(trimmed);
    } catch (err) {
      // Persisting failed (disk full, permission, …). The in-memory
      // rotation still succeeded so this process keeps working;
      // log and move on.
      debug("auth", `failed to persist rotated token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    // Always check for the header — the gateway sets it on 2xx as well
    // as some 4xx responses (auth.go writes the header before invoking
    // the next handler, which may then return its own non-2xx).
    this.maybeRotateToken(response);

    if (response.status === 401 || response.status === 403) {
      // Per gateway/api/apiroutes/auth.go: a 401 reaches the client
      // only when the silent refresh attempt itself failed (refresh
      // token expired/revoked, IDP rejected, signature invalid).
      // The user must re-login — there is nothing this client can do.
      throw new AuthExpiredError();
    }

    if (!response.ok) {
      let message = `API error: ${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) {
          message = body.message;
        }
      } catch {
        // ignore parse errors
      }
      const err: ApiError = { message, status: response.status };
      throw err;
    }

    return response.json() as Promise<T>;
  }

  async listConnections(): Promise<Connection[]> {
    return this.request<Connection[]>("/api/connections");
  }

  async getConnection(name: string): Promise<Connection> {
    return this.request<Connection>(`/api/connections/${encodeURIComponent(name)}`);
  }

  async createCredentials(connectionName: string, accessDurationSec: number = 3600): Promise<CredentialsResponse> {
    return this.request<CredentialsResponse>(
      `/api/connections/${encodeURIComponent(connectionName)}/credentials`,
      {
        method: "POST",
        body: JSON.stringify({ access_duration_sec: accessDurationSec } satisfies CredentialsRequest),
      }
    );
  }
}

export function createClient(
  apiUrl: string,
  token: string,
  onTokenRefreshed?: TokenRefreshHandler,
): HoopApiClient {
  return new HoopApiClient(apiUrl, token, onTokenRefreshed);
}
