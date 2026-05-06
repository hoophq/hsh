/**
 * Single source of truth for the hsh version string.
 *
 * Update both this file and `package.json` when cutting a release. The
 * `hsh update` command and `hsh status` use this constant; commander.js
 * surfaces it as `hsh --version` / `hsh -V`.
 *
 * The format is semver without a leading 'v' so it can be compared
 * lexicographically by `compareSemver()` in src/update/version.ts.
 */
export const VERSION = "0.1.0";
