/**
 * Connection-name matching strategy shared by the ssh and kubectl plugins.
 *
 * The previous implementation in ssh.ts / kubectl.ts had two copies of the
 * same logic plus a dangerous substring fallback:
 *
 *   const partial = connections.find(
 *     (c) => c.name.includes(target) || target.includes(c.name)
 *   );
 *
 * which would happily match `ssh prod` to a connection named `production-db`
 * (or any of `prod-foo`, `prod-bar`, …). This module replaces that with a
 * strict, levelled match plus explicit ambiguity reporting so callers can
 * decide whether to warn, prompt, or error.
 *
 * Priority order (most specific wins; we stop at the first level that hits):
 *
 *   1. `exact`         — `c.name === target`
 *   2. `exact-short`   — `c.name === target.split(".")[0]`   (ssh only)
 *      Reason: users frequently `ssh host.internal.example.com` while the
 *      Hoop connection is named `host`. The single-label compare is safe
 *      because we only fall here when no `exact` match exists.
 *   3. `schema-field`  — `c.access_schema.ssh_host === target` (ssh) or
 *                        `c.access_schema.cluster_name === target` (kubectl)
 *   4. `tag`           — `c.tags.hostname || c.tags.host` (ssh) or
 *                        `c.tags.context || c.tags.cluster` (kubectl)
 *
 * NO substring fallback. If none of the levels match → `match: null` →
 * the caller falls through to native passthrough.
 *
 * Ambiguity: when more than one connection matches at the winning level,
 * `candidates` contains all of them and `ambiguous: true`. The caller
 * decides whether to warn + use first or error out.
 */

import type { Connection } from "../api/types.ts";

export type ConnectionKind = "ssh" | "kubectl";

export type MatchLevel = "exact" | "exact-short" | "schema-field" | "tag";

export interface MatchResult {
  /** Picked connection (the first candidate at the winning level), or null. */
  match: Connection | null;
  /**
   * All connections that matched at the winning level. `candidates.length > 1`
   * iff `ambiguous` is true. Always empty when `match` is null.
   */
  candidates: Connection[];
  /** Which level produced the match, or null when no match was found. */
  level: MatchLevel | null;
  /** True when the winning level produced more than one candidate. */
  ambiguous: boolean;
}

export function matchConnection(
  connections: Connection[],
  target: string,
  kind: ConnectionKind,
): MatchResult {
  const layers: Array<{ level: MatchLevel; predicate: (c: Connection) => boolean }> = [
    { level: "exact", predicate: (c) => c.name === target },
  ];

  if (kind === "ssh") {
    const short = target.split(".")[0];
    if (short !== target) {
      layers.push({ level: "exact-short", predicate: (c) => c.name === short });
    }
    layers.push({
      level: "schema-field",
      predicate: (c) => c.access_schema?.ssh_host === target,
    });
    layers.push({
      level: "tag",
      predicate: (c) =>
        c.tags?.hostname === target || c.tags?.host === target,
    });
  } else {
    layers.push({
      level: "schema-field",
      predicate: (c) => c.access_schema?.cluster_name === target,
    });
    layers.push({
      level: "tag",
      predicate: (c) =>
        c.tags?.context === target || c.tags?.cluster === target,
    });
  }

  for (const { level, predicate } of layers) {
    const candidates = connections.filter(predicate);
    if (candidates.length > 0) {
      return {
        match: candidates[0],
        candidates,
        level,
        ambiguous: candidates.length > 1,
      };
    }
  }

  return { match: null, candidates: [], level: null, ambiguous: false };
}

/**
 * Format a one-line ambiguity warning suitable for stderr. Pure helper so
 * tests can assert the exact wording.
 */
export function formatAmbiguityWarning(
  target: string,
  result: MatchResult,
): string {
  const names = result.candidates.map((c) => c.name).join(", ");
  return `Multiple Hoop connections match '${target}' at level '${result.level}': ${names}. Using '${result.match!.name}'.`;
}
