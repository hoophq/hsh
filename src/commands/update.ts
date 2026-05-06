import { Command } from "commander";
import { join } from "path";
import { ApiUnreachableError } from "../api/client.ts";
import {
  fetchLatestRelease,
  findAsset,
  findExpectedSha256,
  resolveChannel,
} from "../update/releases.ts";
import { downloadAndInstall } from "../update/install.ts";
import {
  assetNameForCurrentPlatform,
  compareSemver,
  stripV,
} from "../update/version.ts";
import { getHshDir } from "../config/store.ts";
import { safeWriteJson } from "../util/safe-write.ts";
import { VERSION } from "../version.ts";
import { ExitCodes } from "../plugins/exit-codes.ts";
import { error, info, success, warn, dim } from "../ui/output.ts";
import { debug } from "../ui/log.ts";

export const updateCommand = new Command("update")
  .description(
    "Check GitHub Releases and self-update to the latest version (set HSH_UPDATE_CHANNEL=prerelease for pre-releases)",
  )
  .option("-y, --yes", "Skip the confirmation prompt and install immediately")
  .option(
    "--check",
    "Only check whether an update is available; do not download",
  )
  .action(async (opts: { yes?: boolean; check?: boolean }) => {
    const channel = resolveChannel();
    info(`Current version: ${VERSION}`);
    info(`Channel: ${channel}`);

    // 1. Resolve the asset name for this platform — fail fast if unsupported.
    const assetName = assetNameForCurrentPlatform();
    if (!assetName) {
      error(
        `Unsupported platform: ${process.platform}/${process.arch}. ` +
          `Supported: linux/x64, linux/arm64, darwin/x64, darwin/arm64, win32/x64.`,
      );
      process.exit(ExitCodes.GenericError);
    }
    debug("update", `target asset name=${assetName}`);

    // 2. Fetch the latest release for the channel.
    let release;
    try {
      release = await fetchLatestRelease(channel);
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        error(`Could not reach GitHub Releases: ${err.reason}`);
        process.exit(ExitCodes.GenericError);
      }
      error(`Update check failed: ${String(err)}`);
      process.exit(ExitCodes.GenericError);
    }
    if (!release) {
      warn(`No releases found on the '${channel}' channel.`);
      process.exit(ExitCodes.Success);
    }

    // Prime the cache so `hsh status` surfaces the same answer for the
    // next 24h without hitting the GitHub API again. Best-effort — we
    // don't want a write failure to break the user's update flow.
    try {
      const cachePath = join(getHshDir(), "update-check.json");
      safeWriteJson(
        cachePath,
        {
          checkedAt: Date.now(),
          latestTag: release.tag_name,
          channel,
          releaseName: release.name ?? undefined,
          releaseUrl: release.html_url,
        },
        { mode: 0o600 },
      );
    } catch (e) {
      debug("update", `failed to prime cache: ${String(e)}`);
    }

    const latest = stripV(release.tag_name);
    info(`Latest available: ${release.tag_name}${release.prerelease ? " (pre-release)" : ""}`);

    // 3. Decide what to do.
    const cmp = compareSemver(latest, VERSION);
    if (cmp <= 0) {
      success(`You're already on the latest version (${VERSION}).`);
      process.exit(ExitCodes.Success);
    }

    info(`Update available: ${VERSION} → ${latest}`);
    if (release.html_url) {
      dim(`Release notes: ${release.html_url}`);
    }
    if (opts.check) {
      // Just reporting; don't install.
      process.exit(ExitCodes.Success);
    }

    // 4. Find the platform-appropriate asset.
    const asset = findAsset(release, assetName);
    if (!asset) {
      error(
        `Release ${release.tag_name} has no '${assetName}' asset. ` +
          `Available: ${release.assets.map((a) => a.name).join(", ") || "none"}.`,
      );
      process.exit(ExitCodes.GenericError);
    }

    // 5. Confirm with the user (unless --yes).
    if (!opts.yes) {
      // Bun has no built-in synchronous prompt; use a quick stdin read.
      // We're at an interactive prompt — short timeout is fine.
      process.stderr.write(
        `\nProceed with upgrade to ${release.tag_name}? [y/N] `,
      );
      const answer = await readLine();
      const yes = answer.trim().toLowerCase().startsWith("y");
      if (!yes) {
        info("Aborted.");
        process.exit(ExitCodes.Success);
      }
    }

    // 6. Try to fetch the expected SHA256.
    info("Looking up checksum...");
    let expectedSha256: string | null = null;
    try {
      expectedSha256 = await findExpectedSha256(release, assetName);
    } catch (err) {
      debug("update", `checksum lookup error: ${String(err)}`);
    }
    if (expectedSha256) {
      dim(`Expected SHA256: ${expectedSha256}`);
    } else {
      warn(
        "No SHA256SUMS asset or matching checksum line found in the release notes — proceeding without verification.",
      );
    }

    // 7. Download + verify + atomic-replace.
    info(`Downloading ${asset.name} (${formatBytes(asset.size)})...`);
    const binPath = process.execPath;
    debug("update", `binPath=${binPath}`);
    try {
      const result = await downloadAndInstall({
        url: asset.browser_download_url,
        expectedSha256,
        binPath,
      });
      if (result.verified) {
        dim(`Verified SHA256: ${result.computedSha256}`);
      } else {
        dim(`SHA256: ${result.computedSha256} (unverified)`);
      }
    } catch (err) {
      if (err instanceof ApiUnreachableError) {
        error(`Download failed: ${err.reason}`);
      } else {
        error(`Update failed: ${String(err)}`);
      }
      process.exit(ExitCodes.GenericError);
    }

    success(`Updated hsh to ${release.tag_name}.`);
    info(`Run 'hsh --version' to confirm.`);
    process.exit(ExitCodes.Success);
  });

/**
 * Read one line from stdin. Used solely for the y/N confirmation.
 * Returns "" if stdin is closed or piped (treats as "no").
 */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Piped/closed stdin: assume no, don't hang waiting for input.
      resolve("");
      return;
    }
    let buf = "";
    process.stdin.setEncoding("utf-8");
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
