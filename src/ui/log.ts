import chalk from "chalk";

/**
 * Debug logger gated on the `HSH_DEBUG` environment variable.
 *
 * Cost: a single env var read + truthy check. Negligible when the flag
 * is unset (the common case). Output goes to stderr so it doesn't pollute
 * the program's stdout (which may be piped into other tools).
 *
 * Format is intentionally simple and grep-friendly:
 *
 *   [hsh debug] <component> <message>
 *
 * Example: `[hsh debug] match: target=prod-cluster level=exact name=prod-cluster ambiguous=false`
 *
 * SECURITY: Never pass tokens, passwords, or refresh tokens to `debug()`.
 * Reviewers should grep call sites for `token`, `password`, `proxy_token`,
 * `refresh_token` to verify. The helper makes no attempt to redact for you.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function isDebugEnabled(): boolean {
  const v = process.env.HSH_DEBUG;
  if (!v) return false;
  return TRUTHY.has(v.toLowerCase());
}

/**
 * Write one line to stderr if HSH_DEBUG is enabled. The component prefix is
 * optional but recommended; it makes filtering with grep / awk trivial:
 *
 *   HSH_DEBUG=1 ssh host 2>&1 >/dev/null | grep '\[hsh debug\] match:'
 *
 * Extra arguments are appended space-separated. Passing objects emits them
 * via JSON.stringify so they survive the stream readably; callers who want
 * a custom format should pre-format into a string.
 */
export function debug(component: string, message: string, ...extras: unknown[]): void {
  if (!isDebugEnabled()) return;
  const parts: string[] = [chalk.gray("[hsh debug]"), `${component}:`, message];
  for (const e of extras) {
    if (e === null || e === undefined) {
      parts.push(String(e));
      continue;
    }
    if (typeof e === "string" || typeof e === "number" || typeof e === "boolean") {
      parts.push(String(e));
      continue;
    }
    try {
      parts.push(JSON.stringify(e));
    } catch {
      parts.push(String(e));
    }
  }
  console.error(parts.join(" "));
}
