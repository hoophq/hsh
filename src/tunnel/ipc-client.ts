/**
 * Client for the hsh-tunneld local HTTP/JSON control plane.
 *
 * Talks to the daemon over a unix domain socket (Linux/macOS) or a
 * named pipe (Windows; not yet implemented daemon-side — see
 * tunnel/ipc/socket_windows.go). On Bun this is one line of config:
 * `fetch(url, { unix: socketPath })` natively understands unix sockets.
 *
 * The contract is the one published in tunnel/ipc/openapi.yaml in
 * hoophq/hoop. See types.ts for the wire shapes.
 */

import { debug } from "../ui/log.ts";
import { readControlToken, resolveSocketPath } from "./socket-path.ts";
import type {
  ConfigResponse,
  ConfigUpdateRequest,
  Connection,
  ConnectionsResponse,
  ErrorBody,
  ErrorCode,
  LoginPollResponse,
  LoginStartResponse,
  ReconnectResponse,
  StatusResponse,
} from "./types.ts";

/**
 * Typed error thrown by every TunnelClient method when the daemon
 * returns a non-2xx response. Callers can match on `code` for known
 * failure modes:
 *
 *   try { await client.status(); }
 *   catch (e) {
 *     if (e instanceof TunnelApiError && e.code === "unauthorized") { ... }
 *   }
 *
 * For lower-level transport failures (daemon not running, socket file
 * missing, etc.) we throw `TunnelUnavailableError` instead.
 */
export class TunnelApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: ErrorCode;

  constructor(statusCode: number, message: string, code?: ErrorCode) {
    super(message);
    this.name = "TunnelApiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  /** 401 — bearer token missing or invalid; usually means the daemon rotated. */
  isUnauthorized(): boolean {
    return this.statusCode === 401;
  }

  /** 501 — endpoint exists in the spec but the daemon hasn't wired it yet. */
  isNotImplemented(): boolean {
    return this.statusCode === 501;
  }
}

/**
 * Thrown when we cannot even reach the daemon (no socket file, no
 * token, connection refused). Distinct from TunnelApiError so the UI
 * can show "daemon not running, run hsh tunnel start" instead of
 * "internal error". Always wraps a cause for `--debug` callers.
 */
export class TunnelUnavailableError extends Error {
  public readonly reason: "no-socket" | "no-token" | "connect-failed" | "timeout";

  constructor(reason: TunnelUnavailableError["reason"], message: string, cause?: unknown) {
    super(message);
    this.name = "TunnelUnavailableError";
    this.reason = reason;
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface TunnelClientOptions {
  /** Override socket path. Defaults to the resolved system path. */
  socketPath?: string;
  /** Override token. Defaults to reading the token file. */
  token?: string;
  /** Per-request timeout in ms. Defaults to 5000 — local socket should be fast. */
  timeoutMs?: number;
}

export class TunnelClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  /**
   * Construct a client. Caller is expected to handle the "daemon not
   * running" path BEFORE getting here (via `connect()` static helper)
   * so error messages can distinguish "not installed" from "running but
   * rejected my token".
   */
  constructor(opts: TunnelClientOptions & { socketPath: string; token: string }) {
    this.socketPath = opts.socketPath;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /**
   * Build a client by resolving the platform defaults and reading the
   * control token. Throws TunnelUnavailableError with a precise reason
   * when the daemon clearly isn't usable — caller renders the right
   * "next step" hint to the user.
   */
  static connect(opts: TunnelClientOptions = {}): TunnelClient {
    const sock = opts.socketPath ?? resolveSocketPath().path;
    if (!sock) {
      throw new TunnelUnavailableError("no-socket", "tunnel socket path is unset");
    }
    const token = opts.token ?? readControlToken();
    if (!token) {
      throw new TunnelUnavailableError(
        "no-token",
        `control token not readable (expected at the daemon's --ipc-token-file path; set HSH_TUNNELD_TOKEN_FILE to override)`
      );
    }
    debug("tunnel.ipc", "connect", { socketPath: sock });
    return new TunnelClient({ socketPath: sock, token });
  }

  // ----- one method per /v1 endpoint -----

  status(): Promise<StatusResponse> {
    return this.do<StatusResponse>("GET", "/v1/status");
  }

  async connections(): Promise<Connection[]> {
    const resp = await this.do<ConnectionsResponse>("GET", "/v1/connections");
    return resp.connections;
  }

  loginStart(): Promise<LoginStartResponse> {
    return this.do<LoginStartResponse>("POST", "/v1/login/start");
  }

  loginPoll(state: string): Promise<LoginPollResponse> {
    if (!state) throw new Error("loginPoll: state is required");
    return this.do<LoginPollResponse>("GET", `/v1/login/poll?state=${encodeURIComponent(state)}`);
  }

  async logout(): Promise<void> {
    await this.do<void>("POST", "/v1/logout");
  }

  config(): Promise<ConfigResponse> {
    return this.do<ConfigResponse>("GET", "/v1/config");
  }

  updateConfig(req: ConfigUpdateRequest): Promise<ConfigResponse> {
    return this.do<ConfigResponse>("PUT", "/v1/config", req);
  }

  reconnect(): Promise<ReconnectResponse> {
    return this.do<ReconnectResponse>("POST", "/v1/reconnect");
  }

  // ----- transport -----

  /**
   * One round-trip. Returns the decoded body for 2xx, throws
   * TunnelApiError for documented non-2xx, throws
   * TunnelUnavailableError for transport-level failures.
   *
   * The host part of the URL is irrelevant — Bun's `unix:` option
   * overrides it — but `localhost` is the conventional placeholder.
   */
  private async do<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `http://hsh-tunneld${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, {
        // Bun-specific: route fetch through the given unix socket.
        // Falls back to a thrown TypeError on stock Node — this file
        // is Bun-only (the whole hsh CLI is).
        unix: this.socketPath,
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      } as RequestInit & { unix: string });
    } catch (err) {
      // AbortController fires AbortError; everything else is a
      // genuine transport failure (ENOENT on the socket, ECONNREFUSED
      // from a half-shut daemon, etc.).
      const reason: TunnelUnavailableError["reason"] =
        (err as Error)?.name === "AbortError" ? "timeout" : "connect-failed";
      throw new TunnelUnavailableError(
        reason,
        reason === "timeout"
          ? `daemon did not respond within ${this.timeoutMs}ms`
          : `failed to reach daemon at ${this.socketPath}: ${(err as Error).message}`,
        err
      );
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 200 && resp.status < 300) {
      if (resp.status === 204) return undefined as T;
      // Some endpoints (Reconnect 202) still return a body; consume it
      // generically so callers don't need to remember which is which.
      const text = await resp.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new TunnelApiError(
          resp.status,
          `daemon returned malformed JSON: ${(err as Error).message}`
        );
      }
    }

    // Error path: try to decode the standard ErrorBody. If the daemon
    // emitted something else, fall back to the raw text so the operator
    // still sees a useful message.
    const text = await resp.text();
    let parsed: ErrorBody | undefined;
    try {
      parsed = text ? (JSON.parse(text) as ErrorBody) : undefined;
    } catch {
      parsed = undefined;
    }
    throw new TunnelApiError(
      resp.status,
      parsed?.error ?? text ?? `HTTP ${resp.status}`,
      parsed?.code
    );
  }
}
