import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "fs";
import { dirname, basename, join } from "path";

/**
 * Write `content` to `finalPath` atomically.
 *
 * Two terminals racing to update the same auth/credential file would
 * previously interleave their `writeFileSync` calls, leaving half-written
 * JSON behind. The next read fails and the user gets bounced back through
 * an OAuth round-trip for no reason.
 *
 * Strategy:
 *   1. Write to `<finalPath>.<pid>.<rand>.tmp` in the SAME directory as
 *      `finalPath` (must be the same filesystem for `rename` to be atomic).
 *   2. fsync the temp file so its contents hit disk before the rename.
 *   3. rename → atomic on POSIX. The destination either still has the old
 *      bytes or the new bytes, never a torn write.
 *   4. Best-effort fsync of the parent directory so the rename itself
 *      survives a crash. Errors are swallowed (some filesystems / non-POSIX
 *      platforms don't support fsync on directories).
 *
 * The file mode is set when the temp file is opened (default 0o600 — these
 * are credential files, never group/world-readable). The mode survives the
 * rename.
 */
export function safeWrite(
  finalPath: string,
  content: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const mode = opts.mode ?? 0o600;
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  // Suffix with pid + 9 random hex chars to avoid collisions when the same
  // process writes multiple files concurrently.
  const tmpName = `.${base}.${process.pid}.${randHex(9)}.tmp`;
  const tmpPath = join(dir, tmpName);

  // O_WRONLY | O_CREAT | O_EXCL — fail loudly if the temp path somehow
  // already exists rather than silently overwriting it. We re-roll the
  // suffix on the (extremely unlikely) collision.
  const fd = openSync(tmpPath, "wx", mode);
  try {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    writeSync(fd, buf, 0, buf.length, null);
    try {
      fsyncSync(fd);
    } catch {
      // best-effort; some filesystems return EINVAL for fsync on certain fds
    }
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, finalPath);

  // Best-effort fsync of the parent dir so the rename is durable across crashes.
  // Bun's fs.openSync supports opening a directory in read mode on POSIX.
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Skipped on platforms / filesystems that don't allow this — non-fatal.
  }
}

/**
 * JSON convenience wrapper. Pretty-prints with 2-space indent + trailing
 * newline (matches the existing files).
 */
export function safeWriteJson(
  finalPath: string,
  data: unknown,
  opts: { mode?: number } = {},
): void {
  safeWrite(finalPath, JSON.stringify(data, null, 2) + "\n", opts);
}

function randHex(bytes: number): string {
  // crypto.getRandomValues is available in Bun without an import.
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
