/**
 * GitHub Releases client used by `hsh update` and `hsh status`.
 *
 * One repo (hoophq/hsh), two endpoints we care about:
 *
 *   GET /repos/hoophq/hsh/releases/latest        → newest non-prerelease
 *   GET /repos/hoophq/hsh/releases               → list (incl. prereleases)
 *
 * `latest` is what we want for the default "stable" channel. For
 * `HSH_UPDATE_CHANNEL=prerelease` we hit the list endpoint and pick the
 * first entry (GitHub returns them newest-first).
 *
 * No authentication needed for public repos — but every unauthenticated
 * request counts toward the 60/h IP-rate-limit. Hot-reload-loop developers
 * may run into that; `hsh update` is normally hand-invoked so it's fine.
 */

import { ApiUnreachableError, fetchWithTimeout } from "../api/client.ts";

const REPO = "hoophq/hsh";

/**
 * GitHub API base URL. Can be overridden via `HSH_GITHUB_API` for testing
 * (point at a local stub) or for self-hosted GitHub Enterprise. Trailing
 * slashes are tolerated.
 */
function apiBase(): string {
  const override = process.env.HSH_GITHUB_API;
  if (override && override.trim() !== "") {
    return override.replace(/\/+$/, "");
  }
  return "https://api.github.com";
}

/** Generous timeout — GitHub is usually fast but the API can hiccup. */
const RELEASES_TIMEOUT_MS = 10_000;

export type UpdateChannel = "stable" | "prerelease";

export interface ReleaseAsset {
  name: string;
  /** Pre-signed URL good for hours (no auth needed for public repos). */
  browser_download_url: string;
  /** Bytes; useful for a download-progress UI but we don't need it. */
  size: number;
}

export interface Release {
  /** Tag, e.g. `v1.2.3` (with or without leading `v`). */
  tag_name: string;
  /** Marketing name; not used for compare. */
  name: string | null;
  /** Markdown body. We extract SHA256SUMS from here as a fallback. */
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  /** Binaries + checksums attached to the release. */
  assets: ReleaseAsset[];
  html_url: string;
}

/**
 * Resolve the channel from the env var. Defaults to `stable`.
 */
export function resolveChannel(): UpdateChannel {
  const raw = (process.env.HSH_UPDATE_CHANNEL ?? "").toLowerCase().trim();
  if (raw === "prerelease" || raw === "beta") return "prerelease";
  return "stable";
}

/**
 * Fetch the appropriate "latest" release for the channel.
 *
 * Returns `null` when the API replies but no release matches the channel
 * (e.g. the repo has only prereleases on the stable channel). Throws
 * `ApiUnreachableError` on network failure (caller decides whether to
 * warn-and-continue or error out).
 */
export async function fetchLatestRelease(
  channel: UpdateChannel = resolveChannel(),
): Promise<Release | null> {
  if (channel === "stable") {
    const res = await fetchWithTimeout(
      `${apiBase()}/repos/${REPO}/releases/latest`,
      {
        timeoutMs: RELEASES_TIMEOUT_MS,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (res.status === 404) return null; // repo has no stable releases yet
    if (!res.ok) {
      throw new ApiUnreachableError(`GitHub API ${res.status}`);
    }
    return (await res.json()) as Release;
  }

  // prerelease channel: list releases (newest first) and pick the first
  // non-draft. Includes both stable and pre-release; pre-release users
  // accept either.
  const res = await fetchWithTimeout(
    `${apiBase()}/repos/${REPO}/releases?per_page=10`,
    {
      timeoutMs: RELEASES_TIMEOUT_MS,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new ApiUnreachableError(`GitHub API ${res.status}`);
  }
  const list = (await res.json()) as Release[];
  return list.find((r) => !r.draft) ?? null;
}

/**
 * Find the asset matching `name` (e.g. "hsh-linux-x64") in a release.
 * Returns null if missing — the caller should surface a clear error
 * (\"no binary published for your platform\").
 */
export function findAsset(release: Release, name: string): ReleaseAsset | null {
  return release.assets.find((a) => a.name === name) ?? null;
}

/**
 * Try to extract the expected SHA256 for `assetName` from the release.
 *
 * Two sources, in order:
 *
 *   1. A `SHA256SUMS` (or `checksums.txt`) asset attached to the release.
 *      Standard `sha256sum` output: `<hex>  <filename>\n`. We download
 *      it and grep for our asset's name.
 *   2. The release body (markdown) — look for a line of the form
 *      `<hex> <assetName>` or a fenced code block with that pattern.
 *
 * Returns null if the checksum can't be found. Caller decides whether
 * to refuse the upgrade or warn-and-continue.
 */
export async function findExpectedSha256(
  release: Release,
  assetName: string,
): Promise<string | null> {
  // Source 1: dedicated checksums asset.
  const checksumAsset =
    findAsset(release, "SHA256SUMS") ??
    findAsset(release, "checksums.txt") ??
    findAsset(release, "checksums.sha256");
  if (checksumAsset) {
    try {
      const res = await fetchWithTimeout(checksumAsset.browser_download_url, {
        timeoutMs: RELEASES_TIMEOUT_MS,
      });
      if (res.ok) {
        const text = await res.text();
        const found = parseChecksumsFile(text, assetName);
        if (found) return found;
      }
    } catch {
      // Fall through to body parsing.
    }
  }
  // Source 2: scrape the release body.
  if (release.body) {
    return parseChecksumFromBody(release.body, assetName);
  }
  return null;
}

/**
 * Parse a sha256sum-style file. Each line is `<hex>  <filename>` (two
 * spaces, by convention) or `<hex> *<filename>` (binary mode, asterisk).
 * Returns the hex for the matching filename, or null.
 *
 * Exported for tests.
 */
export function parseChecksumsFile(
  contents: string,
  assetName: string,
): string | null {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Match `<64 hex>` followed by whitespace then the name (with optional `*`).
    const m = trimmed.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (m[2] === assetName) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Pull `<hex> <assetName>` out of release-notes markdown. Tolerant of
 * code-fence wrapping.
 *
 * Exported for tests.
 */
export function parseChecksumFromBody(
  body: string,
  assetName: string,
): string | null {
  // Escape regex special characters in the asset name (it has dots).
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`([0-9a-fA-F]{64})\\s+\\*?${escaped}\\b`);
  const m = body.match(re);
  return m ? m[1].toLowerCase() : null;
}
