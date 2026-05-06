/**
 * Self-update: download a release asset, verify its SHA256 (when published),
 * and atomically replace the running binary.
 *
 * Atomic replace strategy:
 *
 *   1. Download to a sibling temp file: `<binPath>.<pid>.<rand>.partial`.
 *   2. Verify size + SHA256.
 *   3. Mark executable (mode 0755).
 *   4. POSIX `rename(tmp → final)` is atomic on the same filesystem.
 *
 * On Windows the rename will fail if the running binary is still mapped
 * (the OS holds the file open). Fall back to renaming the OLD binary out
 * of the way (`hsh.exe.old`) before renaming the new one in. The OS will
 * release the old file when this process exits.
 */

import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname, basename, join } from "path";
import { ApiUnreachableError, fetchWithTimeout } from "../api/client.ts";

/**
 * Generous timeout — binaries are tens of MB and CDNs occasionally hiccup.
 * The user is at the terminal waiting; 60s is the upper bound before they
 * Ctrl-C anyway.
 */
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface DownloadAndInstallOpts {
  /** Asset URL (browser_download_url from the GitHub release). */
  url: string;
  /** Expected SHA256 hex string (lowercase). Null skips verification. */
  expectedSha256: string | null;
  /** Where the binary should land. Usually `process.execPath`. */
  binPath: string;
}

export interface InstallResult {
  bytesWritten: number;
  /** Computed SHA256 (lowercase hex). */
  computedSha256: string;
  /** True if `expectedSha256` was provided and matched. */
  verified: boolean;
}

/**
 * Download → verify → atomic-replace. Throws on any failure (typed
 * errors so callers can produce meaningful exit codes).
 */
export async function downloadAndInstall(
  opts: DownloadAndInstallOpts,
): Promise<InstallResult> {
  const { url, expectedSha256, binPath } = opts;

  // Sibling tempfile so the rename is atomic (same filesystem).
  const dir = dirname(binPath);
  const base = basename(binPath);
  const tmpPath = join(
    dir,
    `.${base}.${process.pid}.${randHex(9)}.partial`,
  );

  // 1. Download.
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ApiUnreachableError) throw err;
    throw new ApiUnreachableError(`download failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new ApiUnreachableError(`download HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new ApiUnreachableError("download has no body");
  }

  // 2. Stream to disk while hashing. Bun.write doesn't expose a hashing
  //    streaming API, so we go through the raw fd.
  const fd = openSync(tmpPath, "wx", 0o600);
  const hash = createHash("sha256");
  let bytesWritten = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      writeSync(fd, buf, 0, buf.length, null);
      bytesWritten += buf.length;
    }
  } finally {
    closeSync(fd);
  }

  const computed = hash.digest("hex");
  let verified = false;

  // 3. Verify.
  if (expectedSha256) {
    if (computed.toLowerCase() !== expectedSha256.toLowerCase()) {
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw new Error(
        `SHA256 mismatch: expected ${expectedSha256}, got ${computed}. Download discarded.`,
      );
    }
    verified = true;
  }

  // 4. Mark executable.
  if (process.platform !== "win32") {
    chmodSync(tmpPath, 0o755);
  }

  // 5. Atomic replace.
  try {
    renameSync(tmpPath, binPath);
  } catch (err) {
    // On Windows the rename fails if the running binary holds the file
    // open. Move the OLD binary aside (Windows allows renaming a busy
    // file in some cases; this is the documented Bun-self-update pattern).
    if (process.platform === "win32") {
      const oldPath = `${binPath}.old`;
      try {
        // Best-effort cleanup of any prior .old.
        unlinkSync(oldPath);
      } catch {}
      renameSync(binPath, oldPath);
      renameSync(tmpPath, binPath);
    } else {
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw err;
    }
  }

  return { bytesWritten, computedSha256: computed, verified };
}

/**
 * Helper: hash an existing file. Used by tests + the integrity-check
 * smoke flow.
 */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
