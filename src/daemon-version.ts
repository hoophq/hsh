/**
 * Single source of truth for the version of `hsh-tunneld` that this
 * build of `hsh` ships alongside.
 *
 * # Pinning model
 *
 * `HSH_TUNNELD_VERSION` is either:
 *
 *   - The literal string `"latest"` — the default. The build script
 *     resolves this at build time by calling the GitHub API for the
 *     hoophq/hoop "latest" release tag, then downloads the matching
 *     daemon binary. Each `bun run build` invocation may therefore
 *     produce archives that ship a different daemon version than the
 *     previous build, which is the *right* default for our
 *     fast-moving alpha period: cutting a new hsh release auto-picks
 *     up the most recent daemon fixes.
 *
 *   - A pinned tag like `"1.82.0"` — overrides the default. Used to
 *     reproduce historical builds, or to deliberately downgrade the
 *     bundled daemon when a regression lands upstream. Hoop release
 *     tags are bare semver (`1.82.0`), *not* `v`-prefixed.
 *
 * # Env-var override
 *
 * `HSH_TUNNELD_VERSION` in the environment overrides this constant
 * unconditionally. The build script reads `process.env.HSH_TUNNELD_VERSION`
 * first and falls back to this constant.
 *
 * Example CI invocation:
 *
 *   HSH_TUNNELD_VERSION=1.82.0 bun run build
 *
 * # Why not in package.json
 *
 * Putting the pin here (rather than in `package.json`) keeps build
 * configuration close to the code that consumes it. The build script
 * imports this constant directly, so the dependency is type-checked
 * by TypeScript — a typo (`"lates"`) becomes a compile error rather
 * than a runtime "release not found" 30 seconds into the build.
 *
 * Current pin: `1.82.0` — the first hoop release whose hsh-tunneld
 * assets cover Linux + macOS (amd64/arm64). Bump this when cutting a
 * new hsh release against a newer, fully-uploaded hoop release.
 *
 * # Build-time stamp file
 *
 * Once the build resolves the version (either "latest" -> X.Y.Z or
 * the user-pinned tag), it writes the *resolved* version into
 * `src/daemon-version-stamp.ts`. That stamp
 * is what `hsh --version` reads at runtime, so users always see the
 * concrete version of the daemon they have, not the symbolic
 * "latest" placeholder.
 */
export const HSH_TUNNELD_VERSION = "1.82.0";

/**
 * Type guard returning true when the version string is the symbolic
 * "latest" placeholder. Used by the build script to branch on
 * "resolve from API" vs "use as-is" without sprinkling string
 * comparisons everywhere.
 */
export function isLatest(v: string): boolean {
  return v.trim().toLowerCase() === "latest";
}
