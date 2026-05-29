/**
 * scripts/lib/archive.ts — tar.gz / zip the staged per-target tree.
 *
 * We deliberately shell out to system `tar` and `zip` rather than
 * using a Node/Bun library:
 *
 *   - tar(1) is universally available on every CI runner we care
 *     about (Linux/macOS GitHub Actions images, Bun's own Docker
 *     builds, dev laptops). It produces gnu-tar-compatible output
 *     that `tar -xzf` on the user's side decodes correctly without
 *     any format-version edge cases.
 *
 *   - zip(1) is the macOS/Linux companion for producing
 *     PowerShell-compatible archives. Windows users unpack with
 *     either Explorer (tar.gz support since 22H2) or PowerShell's
 *     Expand-Archive; we ship .zip because both handle it
 *     uniformly, while tar.gz on older Windows still requires a
 *     third-party tool.
 *
 *   - Pulling a tar-builder library into the build pipeline (tar
 *     package on npm is the obvious choice) would lock us into a
 *     specific version's quirks; the system tools have ~30 years of
 *     stability behind them.
 *
 * The downside is that the build is non-hermetic in the strict sense
 * — but for a tool whose own runtime *is* Bun (which has tar+gzip
 * dynamically linked), holding the build script to a higher
 * hermeticity standard than the artifact it produces would be
 * theatre.
 */

import { $ } from "bun";
import { stat } from "fs/promises";
import { basename, dirname } from "path";

/**
 * Create a gzipped tar archive of `stagingDir` written to `outPath`.
 *
 * The archive's top-level entry is `basename(stagingDir)` — i.e.
 * unpacking `hsh-linux-x64.tar.gz` produces a `hsh-linux-x64/`
 * directory, not a flat dump in the cwd. This is the convention
 * every popular "download our CLI" tarball follows (Hashicorp,
 * Cloudflare, Docker, etc.) and what our install.sh expects.
 *
 * We pass `-C dirname(stagingDir)` + `basename(stagingDir)` rather
 * than tar'ing in-place because tar's behaviour around storing
 * leading paths varies between BSD tar and GNU tar; explicit `-C`
 * + relative path normalises it.
 */
export async function makeTarGz(stagingDir: string, outPath: string): Promise<void> {
  const parent = dirname(stagingDir);
  const name = basename(stagingDir);

  // Reset ownership + mtime so the archive is reproducible across
  // build hosts. uid/gid 0 is the GNU-tar default for `--owner` /
  // `--group`; mtime SOURCE_DATE_EPOCH (or current time if unset)
  // keeps the artifact byte-deterministic for users running diffs.
  const sourceDate = process.env.SOURCE_DATE_EPOCH ?? `${Math.floor(Date.now() / 1000)}`;
  await $`tar \
    --sort=name \
    --owner=0 --group=0 --numeric-owner \
    --mtime=@${sourceDate} \
    -C ${parent} \
    -czf ${outPath} \
    ${name}`.quiet();
}

/**
 * Create a zip archive of `stagingDir` written to `outPath`.
 *
 * `-r` recurses; `-X` strips extra OS-specific attributes that vary
 * between build hosts and would otherwise make the archive non-
 * reproducible. We do NOT pass `-q` (quiet) because zip's output is
 * useful when a permission error trips it up.
 */
export async function makeZip(stagingDir: string, outPath: string): Promise<void> {
  const parent = dirname(stagingDir);
  const name = basename(stagingDir);

  // Match makeTarGz's directory-shape: unzipping produces
  // `hsh-windows-x64/`, not a flat dump. zip's -C is `cd` (so we
  // `cd <parent>` then archive `<name>`).
  await $`cd ${parent} && zip -r -X ${outPath} ${name}`.quiet();
}

/**
 * stat() the file and return its size in bytes. Used in the build
 * script to print a "produced N MB archive" summary line that
 * doubles as a sanity check (tar.gz containing only the daemon
 * binary should be ~10–15 MB; far outside that range is a sign of a
 * staging bug).
 */
export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
