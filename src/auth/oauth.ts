import { saveTokenFromJwt } from "./store.ts";
import { getApiUrl } from "../config/store.ts";
import { error, success, info, warn } from "../ui/output.ts";
import open from "open";

// Fixed port matching the Hoop gateway's default: http://127.0.0.1:3587/callback
// See: hoophq/hoop common/proto/const.go → ClientLoginCallbackAddress
const CALLBACK_ADDRESS = "127.0.0.1";
const CALLBACK_PORT = 3587;
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes, matching the Hoop gateway

export async function performOAuthLogin(): Promise<void> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  // 1. Start callback server first
  const tokenPromise = startCallbackServer();

  // 2. Request the login URL from the gateway
  let browserUrl: string;
  try {
    const response = await fetch(`${apiUrl}/api/login`);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `API returned ${response.status}`);
    }
    const body = (await response.json()) as { login_url?: string; message?: string };
    if (!body.login_url) {
      throw new Error(body.message ?? "No login URL returned by the API");
    }
    browserUrl = body.login_url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to get login URL: ${msg}`);
    warn("Make sure the API URL is correct: " + apiUrl);
    process.exit(1);
  }

  // 3. Open browser
  info("Opening browser for authentication...");
  info(`If the browser doesn't open, visit:\n${browserUrl}`);

  try {
    await open(browserUrl);
  } catch {
    warn("Could not open browser automatically. Please open the URL above manually.");
  }

  // 4. Wait for the callback token
  const token = await tokenPromise;
  saveTokenFromJwt(token);
  success("Successfully authenticated with Hoop!");
}

async function startCallbackServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Authentication timed out after 3 minutes"));
    }, LOGIN_TIMEOUT_MS);

    const server = Bun.serve({
      hostname: CALLBACK_ADDRESS,
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== CALLBACK_PATH) {
          return new Response("Not found", { status: 404 });
        }

        const errParam = url.searchParams.get("error");
        if (errParam) {
          clearTimeout(timeout);
          setTimeout(() => server.stop(), 500);
          reject(new Error(`Login failed: ${errParam}`));
          return new Response(errorHtml(errParam), {
            headers: { "Content-Type": "text/html" },
          });
        }

        const token = url.searchParams.get("token");
        if (!token) {
          return new Response(errorHtml("No token received"), {
            headers: { "Content-Type": "text/html" },
          });
        }

        clearTimeout(timeout);
        setTimeout(() => server.stop(), 500);

        resolve(token);

        return new Response(successHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
  });
}

function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Hoop - Authenticated</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8f9fa;">
  <div style="text-align: center; padding: 2rem;">
    <h1 style="color: #22c55e;">Authenticated!</h1>
    <p style="color: #6b7280;">You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Hoop - Error</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8f9fa;">
  <div style="text-align: center; padding: 2rem;">
    <h1 style="color: #ef4444;">Authentication Error</h1>
    <p style="color: #6b7280;">${message}</p>
  </div>
</body>
</html>`;
}
