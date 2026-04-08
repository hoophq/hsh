import { saveTokenFromJwt } from "./store.ts";
import { getApiUrl } from "../config/store.ts";
import { error, success, info } from "../ui/output.ts";
import open from "open";

const CALLBACK_PATH = "/callback";

export async function performOAuthLogin(): Promise<void> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    error("API URL not configured. Run: hsh config set api-url <url>");
    process.exit(1);
  }

  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

  const tokenPromise = startCallbackServer(port);

  const loginUrl = `${apiUrl}/login?redirect=${encodeURIComponent(redirectUri)}`;
  info(`Opening browser for authentication...`);
  info(`If the browser doesn't open, visit:\n${loginUrl}`);

  await open(loginUrl);

  const token = await tokenPromise;
  saveTokenFromJwt(token);
  success("Successfully authenticated with Hoop!");
}

async function startCallbackServer(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Authentication timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    const server = Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== CALLBACK_PATH) {
          return new Response("Not found", { status: 404 });
        }

        const token = url.searchParams.get("token");
        if (!token) {
          return new Response(errorHtml("No token received"), {
            headers: { "Content-Type": "text/html" },
          });
        }

        clearTimeout(timeout);
        // Defer the server stop to allow the response to be sent
        setTimeout(() => server.stop(), 500);

        resolve(token);

        return new Response(successHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
  });
}

async function findAvailablePort(): Promise<number> {
  // Try a random port in the ephemeral range
  const min = 49152;
  const max = 65535;
  return Math.floor(Math.random() * (max - min + 1)) + min;
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
