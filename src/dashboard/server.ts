/**
 * src/dashboard/server.ts — Bun.serve HTTP server for the dashboard.
 *
 * Surface
 *
 *   GET  /                       -> HTML page (CSRF token stamped in
 *                                   a <meta> tag)
 *   GET  /assets/styles.css      -> embedded CSS
 *   GET  /assets/app.js          -> embedded JS
 *   GET  /api/status             -> proxy /v1/status
 *   GET  /api/connections        -> proxy /v1/connections
 *   POST /api/login/start        -> proxy /v1/login/start         [CSRF]
 *   GET  /api/login/poll?state=… -> proxy /v1/login/poll
 *   POST /api/logout             -> proxy /v1/logout              [CSRF]
 *   GET  /api/commands/:subtype?name=… -> render copy-command
 *
 * Why a thin proxy and not direct browser → daemon IPC
 *
 * The daemon's IPC speaks Unix-socket HTTP with a bearer token only
 * readable by group=hsh. The browser can't reach a unix socket and
 * shouldn't be trusted with the bearer token. The dashboard server
 * (running as the user, with group=hsh membership) is the natural
 * adapter: it holds the token, it does the socket dance, and it
 * exposes a small TCP HTTP surface that the browser can talk to.
 *
 * The proxy is intentionally small — we don't expose every IPC
 * endpoint, only the ones the UI needs. New endpoints land here when
 * a UI change needs them, not before.
 *
 * Why no framework
 *
 * Bun.serve's native router covers everything: path matching, method
 * matching, params. Adding hono / express / fastify would pull in a
 * dep tree larger than the dashboard itself.
 */

import { userInfo } from "os";

import {
  TunnelApiError,
  TunnelClient,
  TunnelUnavailableError,
} from "../tunnel/ipc-client";
import type { ConnectionSubtype } from "../tunnel/types";
import { appJs, indexHtml, stylesCss } from "./assets";
import { renderCommand } from "./commands";
import { csrfToken, verifyCsrf } from "./csrf";

/**
 * Subset of subtypes the dashboard knows how to render commands for.
 * Re-deriving the list from the types module would require importing
 * runtime values, which TypeScript doesn't surface; the lowercased
 * narrow check below is the cheapest way to validate the URL
 * fragment.
 */
const KNOWN_SUBTYPES: ConnectionSubtype[] = [
  "postgres",
  "mysql",
  "mssql",
  "mongodb",
  "oracledb",
  "tcp",
];

/**
 * Resolved shell-level username at server start. Baked into copy
 * commands as the default `-u` / `-U` value. Falls back to `<user>`
 * when the call fails (rare on Linux/macOS, more common on a CI
 * container running without /etc/passwd).
 */
function currentUserName(): string {
  try {
    const u = userInfo();
    return u.username || "<user>";
  } catch {
    return "<user>";
  }
}

/**
 * Errors we expect to occur during normal operation. Mapped to
 * specific HTTP status codes in the handlers; everything else
 * (programming errors, unexpected exceptions) becomes a 500 with a
 * generic body.
 */
function mapDaemonError(err: unknown): Response {
  if (err instanceof TunnelApiError) {
    return jsonResp(err.statusCode, {
      message: err.message,
      code: err.code,
    });
  }
  if (err instanceof TunnelUnavailableError) {
    // 502: the dashboard is up but its upstream (the daemon) isn't.
    // Browser-side code branches on this to show the
    // "daemon unreachable" panel.
    return jsonResp(502, {
      message: err.message,
      reason: err.reason,
    });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResp(500, { message: `internal error: ${msg}` });
}

/**
 * Wrap a value into a JSON response with the given status. Centralised
 * so the Content-Type / charset settings stay consistent.
 */
function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 204 No Content with the standard headers. Reserved for endpoints
 * whose only signal is success/failure.
 */
function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Static asset response with a long cache lifetime. The dashboard
 * server lives for minutes-to-hours and the assets are baked into
 * the binary, so caching them across the browser session is safe.
 */
function staticResp(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * Stamp the per-process CSRF token into the rendered HTML. The
 * template has a placeholder we substitute at request time. Doing
 * this on every request (rather than once at module load) lets us
 * support future per-session tokens without restructuring.
 */
function renderHtml(): string {
  const meta = `<meta name="csrf-token" content="${csrfToken()}" />`;
  // Insert just before </head>. The HTML is hand-controlled so we
  // know there's exactly one </head> and it's followed by a newline.
  return indexHtml.replace("</head>", `    ${meta}\n  </head>`);
}

/**
 * Reject mutating requests that don't carry the CSRF header. Same-
 * origin GETs are always allowed.
 */
function requireCsrf(req: Request): Response | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const token = req.headers.get("X-CSRF-Token");
  if (!verifyCsrf(token)) {
    return jsonResp(403, { message: "missing or invalid CSRF token" });
  }
  return null;
}

/**
 * Build the dashboard route table for Bun.serve. Returns the object
 * verbatim so server creation is `Bun.serve({ ...buildOptions(...) })`.
 *
 * The `client` argument is the TunnelClient handle the server uses
 * to reach the daemon. Injected (not constructed inside) so unit
 * tests can pass a fake.
 */
export interface ServerOptions {
  hostname: string;
  port: number;
  client: TunnelClient;
  userName?: string;
}

export function buildServer(opts: ServerOptions) {
  const userName = opts.userName ?? currentUserName();
  return {
    hostname: opts.hostname,
    port: opts.port,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // ---- static page + assets ----

      if (url.pathname === "/" && req.method === "GET") {
        return staticResp(renderHtml(), "text/html; charset=utf-8");
      }
      if (url.pathname === "/assets/styles.css" && req.method === "GET") {
        return staticResp(stylesCss, "text/css; charset=utf-8");
      }
      if (url.pathname === "/assets/app.js" && req.method === "GET") {
        return staticResp(
          appJs,
          "application/javascript; charset=utf-8",
        );
      }

      // ---- API proxies ----

      // CSRF gate before any side-effectful endpoint touches the
      // daemon. GETs fall through.
      const csrfFail = requireCsrf(req);
      if (csrfFail) return csrfFail;

      try {
        if (url.pathname === "/api/status" && req.method === "GET") {
          return jsonResp(200, await opts.client.status());
        }
        if (url.pathname === "/api/connections" && req.method === "GET") {
          return jsonResp(200, await opts.client.connections());
        }
        if (
          url.pathname === "/api/login/start" &&
          req.method === "POST"
        ) {
          return jsonResp(200, await opts.client.loginStart());
        }
        if (url.pathname === "/api/login/poll" && req.method === "GET") {
          const state = url.searchParams.get("state");
          if (!state) {
            return jsonResp(400, {
              message: "missing required query parameter: state",
            });
          }
          return jsonResp(200, await opts.client.loginPoll(state));
        }
        if (url.pathname === "/api/logout" && req.method === "POST") {
          await opts.client.logout();
          return noContent();
        }

        // /api/commands/:subtype?name=foo
        const cmdMatch = /^\/api\/commands\/([^/?]+)$/.exec(url.pathname);
        if (cmdMatch && req.method === "GET") {
          const subtype = cmdMatch[1].toLowerCase();
          if (!(KNOWN_SUBTYPES as string[]).includes(subtype)) {
            return jsonResp(404, {
              message: `unknown subtype: ${subtype}`,
            });
          }
          const name = url.searchParams.get("name") ?? "";
          if (!name) {
            return jsonResp(400, {
              message: "missing required query parameter: name",
            });
          }
          const command = renderCommand({
            name,
            subtype: subtype as ConnectionSubtype,
            userName,
          });
          return jsonResp(200, { command });
        }
      } catch (err) {
        return mapDaemonError(err);
      }

      // ---- catch-all 404 ----
      return jsonResp(404, { message: "not found" });
    },
  };
}

/**
 * Convenience: build options + start a Bun server. Returns the
 * `Server` instance so callers can `.stop()` on shutdown.
 */
export function startServer(opts: ServerOptions): ReturnType<typeof Bun.serve> {
  return Bun.serve(buildServer(opts));
}
