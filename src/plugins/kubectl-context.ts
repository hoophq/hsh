/**
 * kubectl context detection — figures out which Kubernetes context the
 * user's `kubectl ...` invocation will use, WITHOUT shelling out to the
 * real `kubectl config current-context`.
 *
 * Priority order (mirrors kubectl's own behavior):
 *
 *   1. `--context X` or `--context=X` flag           — wins over everything
 *   2. `--kubeconfig=/path` or `--kubeconfig /path`  — that file's current-context
 *   3. `KUBECONFIG=/path/a:/path/b` env var          — first file's current-context
 *      (kubectl merges left-to-right; the first file's current-context wins)
 *   4. `~/.kube/config`                              — fallback default
 *   5. None of the above                             — null → caller falls open
 *      to native kubectl (covers in-cluster pods, missing config, etc.)
 *
 * We don't import a YAML parser — kubeconfig only has one field we care
 * about (`current-context`) and the format is well-defined enough that a
 * targeted regex covers every real-world style. If we ever need more
 * fields (cluster, user, namespace) we can promote this to a real parser.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Resolve $HOME for kubeconfig lookup.
 *
 * Reads `process.env.HOME` first (matches kubectl's own
 * `os.UserHomeDir()` lookup) and only falls back to Bun's `homedir()`
 * when HOME is unset. This is the supported test seam: HSH_HOME doesn't
 * apply here because we're reading the user's REAL kube config, not
 * hsh's own state directory. `homedir()` is cached by Bun at startup so
 * mid-process `process.env.HOME = ...` overrides only flow through this
 * path.
 */
function resolveHome(): string {
  return process.env.HOME ?? homedir();
}

export type ContextSource =
  | "flag"
  | "kubeconfig-flag"
  | "kubeconfig-env"
  | "default"
  | "none";

export interface ContextDetection {
  /** The resolved context name, or null when nothing is configured. */
  context: string | null;
  /** Which priority level produced the answer. */
  source: ContextSource;
  /** Path of the kubeconfig file that was consulted, if any. */
  fileConsulted: string | null;
}

/**
 * Detect the kubectl context for `args` (the argv slice passed to the
 * plugin's `run`). Pure function modulo filesystem reads.
 */
export function detectContext(args: string[]): ContextDetection {
  // 1. --context flag (wins). Both `--context X` and `--context=X`.
  const ctxFlag = readFlagValue(args, "--context");
  if (ctxFlag !== null) {
    return { context: ctxFlag, source: "flag", fileConsulted: null };
  }

  // 2. --kubeconfig flag → read that file directly.
  const kubeconfigFlag = readFlagValue(args, "--kubeconfig");
  if (kubeconfigFlag !== null) {
    const ctx = readCurrentContextFromFile(kubeconfigFlag);
    return {
      context: ctx,
      source: "kubeconfig-flag",
      fileConsulted: kubeconfigFlag,
    };
  }

  // 3. KUBECONFIG env var → first file's current-context wins (kubectl
  //    merge semantics).
  const env = process.env.KUBECONFIG;
  if (env && env.trim() !== "") {
    const files = env.split(":").map((p) => p.trim()).filter((p) => p.length > 0);
    for (const file of files) {
      const ctx = readCurrentContextFromFile(file);
      if (ctx !== null) {
        return { context: ctx, source: "kubeconfig-env", fileConsulted: file };
      }
    }
    // KUBECONFIG was set but none of the files had a current-context →
    // mirrors kubectl's behavior of having no current context.
    return { context: null, source: "kubeconfig-env", fileConsulted: null };
  }

  // 4. Default ~/.kube/config.
  const defaultPath = join(resolveHome(), ".kube", "config");
  if (existsSync(defaultPath)) {
    const ctx = readCurrentContextFromFile(defaultPath);
    return {
      context: ctx,
      source: "default",
      fileConsulted: defaultPath,
    };
  }

  // 5. No kubeconfig anywhere — likely in-cluster (pod running kubectl
  //    against the in-cluster service account) OR genuinely unconfigured.
  //    Either way, we can't match a Hoop connection — caller passes through.
  return { context: null, source: "none", fileConsulted: null };
}

/**
 * Read `--<flag> X` (separate) or `--<flag>=X` (joined) from `args`.
 * Returns null if the flag isn't present. Stops at `--` end-of-options.
 *
 * Exported solely for tests.
 */
export function readFlagValue(args: string[], flag: string): string | null {
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return null;
    if (a === flag && i + 1 < args.length) return args[i + 1];
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return null;
}

/**
 * Extract `current-context: <value>` from a kubeconfig file. Supports the
 * three styles real-world configs use:
 *
 *   current-context: my-ctx
 *   current-context: "my-ctx"
 *   current-context: 'my-ctx'
 *
 * Inline `# comment` after the value is stripped. Whitespace is trimmed.
 *
 * Returns null when the field is absent, the file doesn't exist, or the
 * file can't be read.
 *
 * Exported solely for tests.
 */
export function readCurrentContextFromFile(path: string): string | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  return extractCurrentContext(content);
}

/**
 * Parse `current-context` out of a kubeconfig YAML string. Pure function;
 * exposed for unit tests so we can pin every form without touching disk.
 *
 * Skips lines inside indented mappings or comment blocks: `current-context`
 * is a top-level scalar in kubeconfig and lives at column 0, so we anchor
 * the match there. This dodges values that legitimately appear nested
 * under another key (some Helm-rendered configs include
 * `cluster: { current-context: ... }` examples in comments / fixtures).
 */
export function extractCurrentContext(content: string): string | null {
  // YAML 1.2 §6.6 says the document's outermost mapping uses 0-indent. We
  // require the line to start at column 0 (no leading whitespace) so an
  // indented occurrence under another key is ignored.
  const re = /^current-context[ \t]*:[ \t]*(.*?)(?:[ \t]+#.*)?$/m;
  const m = content.match(re);
  if (!m) return null;
  let value = m[1].trim();
  // Strip surrounding quotes (double or single). YAML allows either.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // YAML scalar may unescape \" inside double-quoted; we don't bother
  // handling that — context names don't contain escape sequences in
  // practice.
  return value.length > 0 ? value : null;
}
