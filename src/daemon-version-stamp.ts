/**
 * src/daemon-version-stamp.ts — DEFAULT stamp for dev builds.
 *
 * IMPORTANT: this is the source-tree fallback. The release build
 * (scripts/build.ts) overwrites this file with a generated stamp
 * containing the *resolved* daemon version before running
 * `bun build --compile`, so each shipped binary embeds the concrete
 * version it was bundled with.
 *
 * The build script restores this file to its source-tree content
 * after each `bun build --compile` invocation so the working tree
 * stays clean. (See `withStamp` in scripts/build.ts.)
 *
 * Why a separate file (rather than overwriting daemon-version.ts):
 *
 *   - `daemon-version.ts` carries the *build pin* (what we want).
 *     "latest", or a tag like "v0.0.42".
 *   - `daemon-version-stamp.ts` carries the *resolved* concrete
 *     version (what we got). After resolving "latest" -> v0.0.42
 *     at build time, the stamp says "v0.0.42" even though the pin
 *     still says "latest".
 *   - Keeping them separate means `bun run dev` from source reports
 *     the symbolic pin (correct, no bundled daemon to claim), while
 *     a release binary reports the concrete bundled version
 *     (correct, the daemon is right there).
 *
 * This pattern is identical to Go's `-ldflags "-X main.version=$(git
 * describe)"` injection: the source has a placeholder, the build
 * substitutes the real value.
 */

import { HSH_TUNNELD_VERSION } from "./daemon-version";

/**
 * The resolved daemon version bundled with this hsh build.
 *
 * In a published release: a concrete tag like "v0.0.42".
 * In a source-tree dev run: the symbolic constant from
 * `daemon-version.ts` (defaults to "latest").
 */
export const BUNDLED_DAEMON_VERSION: string = HSH_TUNNELD_VERSION;
