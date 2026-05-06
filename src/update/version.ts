/**
 * Pure helpers for the update flow: semver compare + GitHub-asset name
 * resolution. No I/O. Exported as a module so tests can pin every form.
 */

/**
 * Strip a single leading `v` from a tag/version string. GitHub releases
 * are conventionally tagged `v1.2.3`; our internal version constant
 * (src/version.ts) is `1.2.3`.
 */
export function stripV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * Compare two semver strings. Returns:
 *   -1  a < b
 *    0  a == b
 *    1  a > b
 *
 * Both sides may have an optional leading `v`. Pre-release tags are
 * compared lexicographically per semver §11; `1.2.3` > `1.2.3-rc.1`.
 * That ordering is enough for "is the GitHub release newer than mine?"
 * — we don't need the full §11 alphanumeric ID-by-ID compare.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const A = parse(stripV(a));
  const B = parse(stripV(b));
  for (let i = 0; i < 3; i++) {
    if (A.numbers[i] < B.numbers[i]) return -1;
    if (A.numbers[i] > B.numbers[i]) return 1;
  }
  // Numeric portion is equal. Pre-release versions sort BEFORE the same
  // version without a pre-release suffix (1.2.3-rc.1 < 1.2.3).
  if (A.pre === undefined && B.pre === undefined) return 0;
  if (A.pre === undefined) return 1; // a is the release, b is pre-release
  if (B.pre === undefined) return -1;
  if (A.pre < B.pre) return -1;
  if (A.pre > B.pre) return 1;
  return 0;
}

function parse(v: string): { numbers: [number, number, number]; pre: string | undefined } {
  // Strip build metadata: `1.2.3+build.5` → `1.2.3`. Build metadata is
  // ignored for precedence per semver §10.
  const noBuild = v.split("+")[0];
  const dashIdx = noBuild.indexOf("-");
  const core = dashIdx === -1 ? noBuild : noBuild.slice(0, dashIdx);
  const pre = dashIdx === -1 ? undefined : noBuild.slice(dashIdx + 1);
  const parts = core.split(".");
  // Coerce non-numeric segments to 0; treats `1.2` as `1.2.0`. Tolerant
  // of bad input from the GitHub API.
  const numbers: [number, number, number] = [
    parseSegment(parts[0]),
    parseSegment(parts[1]),
    parseSegment(parts[2]),
  ];
  return { numbers, pre };
}

function parseSegment(s: string | undefined): number {
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map (Bun's) `process.platform` + `process.arch` to the asset name we
 * publish in `dist/` (see scripts/build.ts). Returns null for unsupported
 * combinations — caller should error out cleanly.
 */
export function assetNameForCurrentPlatform(): string | null {
  return assetNameFor(process.platform, process.arch);
}

/**
 * Pure variant exported for tests; doesn't read process.* directly so we
 * can pin every (platform, arch) combination without mocking.
 */
export function assetNameFor(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): string | null {
  if (platform === "linux") {
    if (arch === "x64") return "hsh-linux-x64";
    if (arch === "arm64") return "hsh-linux-arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "hsh-darwin-x64";
    if (arch === "arm64") return "hsh-darwin-arm64";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "hsh-windows-x64.exe";
    return null;
  }
  return null;
}
