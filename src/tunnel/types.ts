/**
 * TypeScript counterpart of the hsh-tunneld control-plane spec.
 *
 * Wire-format mirror of:
 *   - tunnel/ipc/spec.go          (Go types)
 *   - tunnel/ipc/openapi.yaml     (OpenAPI 3.1 source of truth)
 * in the hoophq/hoop repository.
 *
 * Field names match the JSON contract exactly (snake_case). When the
 * daemon ships a new endpoint, the order of operations is:
 *
 *   1. Update tunnel/ipc/spec.go + openapi.yaml in hoophq/hoop.
 *   2. Update this file to match.
 *   3. Update ipc-client.ts to expose the new method.
 *
 * Keep the three in lockstep — we deliberately do not code-generate so
 * we can keep both runtimes small.
 */

/**
 * GET /v1/status response.
 *
 * `running` reflects whether the daemon's gVisor tunnel loop is up;
 * `logged_in` is independent and reflects whether the daemon holds a
 * valid hoop token. The UI surfaces both so users can tell e.g.
 * "daemon up, but signed out" apart from "daemon down".
 */
export interface StatusResponse {
  running: boolean;
  logged_in: boolean;
  /** RFC 3339; absent until the daemon enters its running state. */
  since?: string;
  /** Most recent non-fatal error; empty when the daemon is clean. */
  last_error?: string;
  /** Daemon build version (matches common/version.Get().Version). */
  daemon_version: string;
}

/**
 * One entry in GET /v1/connections. The wire shape uses snake_case;
 * we keep that on the client side too so the JSON parses without any
 * transform layer.
 */
export interface Connection {
  name: string;
  subtype: ConnectionSubtype;
  /** ULA IPv6 address inside the tunnel /48. */
  virtual_ip: string;
  /**
   * Canonical TCP port for this protocol (5432 for postgres, 3306 for
   * mysql, ...). 0 for `tcp` subtype, which accepts any user-defined
   * upstream port.
   */
  expected_port: number;
}

/**
 * Subtypes the daemon will tunnel. Anything else (`ssh`, `kubernetes`,
 * `httpproxy`, `rdp`, ...) is filtered out by tunnel/client/connections.go
 * and never appears in this list.
 */
export type ConnectionSubtype =
  | "postgres"
  | "mysql"
  | "mssql"
  | "mongodb"
  | "oracledb"
  | "tcp";

export interface ConnectionsResponse {
  connections: Connection[];
}

/**
 * POST /v1/login/start response. Currently returns 501 in the daemon
 * (the OAuth flow ships with RD-216) — clients should be prepared to
 * see ApiError with code "not_implemented" and surface "sign in via
 * legacy CLI for now" rather than crash.
 */
export interface LoginStartResponse {
  browser_url: string;
  state: string;
}

export type LoginPollStatus = "pending" | "done" | "error";

export interface LoginPollResponse {
  status: LoginPollStatus;
  error?: string;
}

export interface ConfigResponse {
  api_url: string;
  /** Optional override; empty means "auto-discovered from /api/serverinfo". */
  grpc_url?: string;
  log_level: "debug" | "info" | "warn" | "error";
}

/** PUT /v1/config: every field is optional; omitted fields are left untouched. */
export interface ConfigUpdateRequest {
  api_url?: string;
  grpc_url?: string;
  log_level?: "debug" | "info" | "warn" | "error";
}

export interface ReconnectResponse {
  accepted: boolean;
}

/**
 * Canonical JSON error body returned by every non-2xx response from
 * the control plane. The `code` field is the machine-readable identifier
 * — UIs should branch on it rather than string-matching `error`.
 *
 * Known codes (kept in sync with tunnel/ipc/server.go):
 *   - "unauthorized"     → 401, present/invalid bearer token
 *   - "bad_request"      → 400, malformed body or missing query param
 *   - "not_found"        → 404, unknown route
 *   - "not_implemented"  → 501, endpoint advertised but not yet wired
 *   - "internal"         → 500, daemon-side failure
 */
export interface ErrorBody {
  error: string;
  code?: ErrorCode;
}

export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "not_implemented"
  | "internal";
