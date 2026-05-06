/**
 * Cached version check for `hsh status`. Hits GitHub Releases at most
 * once per 24h and caches the result in `~/.hsh/update-check.json`.
 *
 * Off the hot path: status calls this; if the cache is fresh we never
 * touch the network. If it's stale, we *try* to refresh but on any
 * failure we fall back to whatever's cached (offline-friendly).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getHshDir } from "../config/store.ts";
import { safeWriteJson } from "../util/safe-write.ts";
import {
  fetchLatestRelease,
  resolveChannel,
  type Release,
} from "./releases.ts";
import { compareSemver, stripV } from "./version.ts";
import { VERSION } from "../version.ts";
import { debug } from "../ui/log.ts";

const CHECK_FILENAME = "update-check.json";
/** Re-check interval. 24h matches the AC. */
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedCheck {
  /** Last time we hit the GitHub API (ms since epoch). */
  checkedAt: number;
  /** Latest release tag we saw, e.g. "v1.2.3". */
  latestTag: string;
  /** Channel the check was made on. */
  channel: "stable" | "prerelease";
  /** Marketing name (for display). */
  releaseName?: string;
  /** Release page URL (for the "see what's new" hint). */
  releaseUrl?: string;
}

function cachePath(): string {
  return join(getHshDir(), CHECK_FILENAME);
}

function readCached(): CachedCheck | null {
  const path = cachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as CachedCheck;
  } catch {
    return null;
  }
}

function writeCached(release: Release): void {
  const data: CachedCheck = {
    checkedAt: Date.now(),
    latestTag: release.tag_name,
    channel: resolveChannel(),
    releaseName: release.name ?? undefined,
    releaseUrl: release.html_url,
  };
  safeWriteJson(cachePath(), data, { mode: 0o600 });
}

export interface UpdateAvailability {
  /** Currently-running version (without leading 'v'). */
  current: string;
  /** Latest release tag from cache or fresh fetch. Null if unknown. */
  latest: string | null;
  /** True iff `latest` parses as strictly newer than `current`. */
  available: boolean;
  /** Release page URL when known (for "see what's new"). */
  releaseUrl?: string;
}

/**
 * Quick (often-cached) check used by `hsh status`. Returns immediately
 * if the cache is fresh (<24h) or fails open if the network is down.
 *
 * Pass `force: true` to bypass the cache (used by `hsh update`).
 */
export async function checkForUpdate(
  opts: { force?: boolean } = {},
): Promise<UpdateAvailability> {
  const cached = readCached();
  const now = Date.now();
  const channelChanged =
    cached !== null && cached.channel !== resolveChannel();

  if (
    !opts.force &&
    cached &&
    !channelChanged &&
    now - cached.checkedAt < CHECK_TTL_MS
  ) {
    debug("update", `using cached check (age=${now - cached.checkedAt}ms)`);
    return availabilityFrom(cached.latestTag, cached.releaseUrl);
  }

  // Cache stale or absent — fetch.
  try {
    const release = await fetchLatestRelease();
    if (release) {
      writeCached(release);
      return availabilityFrom(release.tag_name, release.html_url);
    }
    // No release at all on this channel.
    return { current: VERSION, latest: null, available: false };
  } catch (err) {
    debug("update", `fetch failed: ${String(err)}`);
    // Fall back to cache if we have one.
    if (cached) {
      return availabilityFrom(cached.latestTag, cached.releaseUrl);
    }
    return { current: VERSION, latest: null, available: false };
  }
}

function availabilityFrom(
  tag: string,
  releaseUrl: string | undefined,
): UpdateAvailability {
  const latest = stripV(tag);
  const available = compareSemver(latest, VERSION) === 1;
  return { current: VERSION, latest, available, releaseUrl };
}
