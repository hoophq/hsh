import { describe, expect, test } from "bun:test";
import { HoopApiClient } from "../src/api/client.ts";

/**
 * Regression test for ENG-361.
 *
 * The gateway's openapi schema defines:
 *   ConnectionCredentialsRequest { AccessDurationSec int `json:"access_duration_seconds"` }
 *
 * hsh used to send `access_duration_sec` (no trailing 's'), which Go's
 * json.Unmarshal silently dropped — leaving the server-side struct field
 * at 0 and producing credentials with `expire_at = now() + 0s`. The
 * resulting credential was already expired by the time the SSH proxy
 * checked it, so password auth failed with "invalid secret access key
 * credentials" or "Permission denied (password)" depending on the path.
 *
 * Discovered live against a real gateway. The wire format is what
 * matters; the in-process types.ts field already matches the wire form
 * (a re-rename later would not catch the regression on its own).
 */

describe("HoopApiClient.createCredentials() wire format (ENG-361)", () => {
  test("sends `access_duration_seconds` (long form) matching gateway openapi schema", async () => {
    let capturedBody: string | null = null;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        // Capture the raw body so we can assert on the JSON key, not on
        // an in-process TypeScript type. The whole point of this test
        // is the wire format.
        capturedBody = await req.text();
        return new Response(
          JSON.stringify({
            id: "x",
            connection_name: "demo",
            connection_type: "application",
            connection_sub_type: "ssh",
            session_id: "s1",
            has_review: false,
            created_at: new Date().toISOString(),
            expire_at: new Date(Date.now() + 3600_000).toISOString(),
            connection_credentials: {
              hostname: "127.0.0.1",
              port: "2233",
              username: "hoop",
              password: "tok",
              command: "",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, "tok");
      await client.createCredentials("demo", 3600);
    } finally {
      server.stop();
    }

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;

    // Must use the long form, matching the gateway's openapi schema.
    expect(parsed).toHaveProperty("access_duration_seconds", 3600);
    // Must NOT include the broken short form (would also be sent if the
    // type were widened — explicit guard against partial regressions).
    expect(parsed).not.toHaveProperty("access_duration_sec");
  });

  test("default 3600s is applied when caller omits the duration", async () => {
    let capturedBody: string | null = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.text();
        return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, "tok");
      // No second argument — should default to 3600 (1h).
      await client.createCredentials("demo");
    } finally {
      server.stop();
    }
    const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
    expect(parsed).toEqual({ access_duration_seconds: 3600 });
  });

  test("round-trip via gateway-shaped fake: returned expire_at reflects the requested duration", async () => {
    // Simulate the gateway's behavior by computing expire_at from the
    // received duration. If hsh ever regresses to the short form, this
    // mock will compute expire_at = now (because the field is missing)
    // and the assertion fails.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { access_duration_seconds?: number };
        const dur = body.access_duration_seconds ?? 0;
        const expireAt = new Date(Date.now() + dur * 1000).toISOString();
        return new Response(
          JSON.stringify({
            id: "x",
            connection_name: "demo",
            connection_type: "application",
            connection_sub_type: "ssh",
            session_id: "s1",
            has_review: false,
            created_at: new Date().toISOString(),
            expire_at: expireAt,
            connection_credentials: {
              hostname: "127.0.0.1",
              port: "2233",
              username: "hoop",
              password: "tok",
              command: "",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      const client = new HoopApiClient(`http://127.0.0.1:${server.port}`, "tok");
      const before = Date.now();
      const resp = await client.createCredentials("demo", 1800);
      const expireAtMs = new Date(resp.expire_at).getTime();
      const remaining = expireAtMs - before;
      // Should be ~1800s = 1_800_000 ms, give or take a few ms latency.
      // The bug would have produced remaining ≈ 0.
      expect(remaining).toBeGreaterThan(1_700_000);
      expect(remaining).toBeLessThan(1_900_000);
    } finally {
      server.stop();
    }
  });
});
