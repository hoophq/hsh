import { fetchWithTimeout } from "../api/client.ts";
import { saveTokenFromJwt } from "./store.ts";
import { error, info, success } from "../ui/output.ts";
import { promptLine, promptPassword, PromptCancelledError } from "./prompt.ts";

/**
 * Local-auth login flow against `auth_method: "local"` gateways.
 *
 * Wire contract (verified live against hoophq/hoop gateway 1.57.x):
 *   POST /api/localauth/login
 *     Content-Type: application/json
 *     {"email": "...", "password": "..."}
 *
 *   200 OK
 *     Token: <jwt>                        ← response header
 *     Access-Control-Expose-Headers: Token
 *     {"status": "ok"}
 *
 *   401 Unauthorized → {"message": "invalid credentials"}
 *   404 Not Found    → {"message": "user not found"}
 *   400 Bad Request  → {"message": "<binding error>"}
 *
 * Important: the JWT is in the `Token` *response header*, NOT the body.
 * Headers.get() is case-insensitive so "Token" vs "token" both work.
 *
 * The user is interactively waiting at the terminal — we use a more
 * generous 10s timeout (matches the OIDC login URL fetch) rather than
 * the 3s default for non-interactive plugin calls.
 */
const LOGIN_API_TIMEOUT_MS = 10_000;

export async function performLocalAuthLogin(apiUrl: string): Promise<void> {
  info("Local authentication. Press Ctrl-C to cancel.");

  let email: string;
  let password: string;
  try {
    email = (await promptLine("Email: ")).trim();
    if (!email) {
      error("Email is required.");
      process.exit(1);
    }
    password = await promptPassword("Password: ");
    if (!password) {
      error("Password is required.");
      process.exit(1);
    }
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      error("Login cancelled.");
      process.exit(1);
    }
    throw err;
  }

  // Send the credentials. fetchWithTimeout classifies network errors
  // into ApiUnreachableError; we let that bubble (the caller renders it).
  const response = await fetchWithTimeout(
    `${apiUrl.replace(/\/+$/, "")}/api/localauth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      timeoutMs: LOGIN_API_TIMEOUT_MS,
    },
  );

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      // ignore parse errors
    }
    // 401/404 are the user-typed-wrong-thing cases — phrase them
    // as "Invalid email or password" rather than echoing the
    // gateway's distinction (which leaks "user does not exist"
    // vs "wrong password").
    if (response.status === 401 || response.status === 404) {
      error("Invalid email or password.");
    } else {
      error(`Login failed: ${detail}`);
    }
    process.exit(1);
  }

  const token = response.headers.get("token");
  if (!token || token.trim() === "") {
    // Shouldn't happen on 200 — gateway always sets the header on
    // success. Defensive: fail loudly rather than persist nothing.
    error("Login succeeded but the gateway did not return a token. This is a server-side bug.");
    process.exit(1);
  }

  saveTokenFromJwt(token.trim());
  // Drain the body so the connection can be reused / closed cleanly.
  try {
    await response.json();
  } catch {
    // ignore
  }

  success(`Successfully authenticated as ${email}.`);
}

/**
 * Wrapper that reports a clear error when the gateway has no users
 * yet (`setup_required: true` from /api/publicserverinfo). Without
 * this, login would just bail with "user not found" 404 from the
 * login endpoint, which is much less actionable.
 */
export function reportSetupRequired(apiUrl: string): never {
  error("This Hoop gateway has no users yet. Register the first admin first:");
  // No backticks around the curl — keeps it copy-pasteable from the
  // terminal even when chalk styling is off.
  console.error("");
  console.error(
    `  curl -X POST ${apiUrl.replace(/\/+$/, "")}/api/localauth/register \\`,
  );
  console.error(`    -H 'Content-Type: application/json' \\`);
  console.error(`    -d '{"email":"you@example.com","password":"...","name":"Your Name"}'`);
  console.error("");
  console.error("Then run `hsh login` again.");
  process.exit(1);
}
