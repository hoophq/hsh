import { join } from "path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { spawnSync } from "child_process";
import { getHshDir } from "../config/store.ts";
import { safeWrite } from "../util/safe-write.ts";
import { debug } from "../ui/log.ts";

/**
 * SSH_ASKPASS-based token injection (ENG-360, follow-up to ENG-346 spike).
 *
 * Replaces the copy-paste token UX in `hsh ssh <connection>` with an
 * automatic injection through OpenSSH's askpass mechanism. The user no
 * longer has to look at the token box, select the token, and paste it —
 * `hsh ssh foo` just becomes a shell on the host.
 *
 * Mechanism (verified empirically in the spike — see
 * docs/decisions/ssh-token-injection.md):
 *
 *   1. Write the per-session token to a 0600 tempfile under
 *      ~/.hsh/askpass/<pid>-<rand>.token.
 *   2. Generate a tiny shell shim that `cat`s that tempfile, marked 0700.
 *   3. Spawn ssh with these env vars set in the CHILD only:
 *        SSH_ASKPASS         = <shim path>
 *        SSH_ASKPASS_REQUIRE = force         (OpenSSH ≥ 8.4)
 *        DISPLAY             = ":0"          (placeholder, but askpass
 *                                             still requires SOME value)
 *   4. After ssh exits (success OR failure), unlink both files.
 *   5. On every `hsh ssh` invocation, sweep ~/.hsh/askpass/ for orphan
 *      files older than ORPHAN_TTL_MS so a crashed parent doesn't leak
 *      tokens forever.
 *
 * SECURITY NOTES
 *
 *   - The TOKEN itself is never in the spawned child's env — only the
 *     PATH to the shim is. `ps -E` / `/proc/<pid>/environ` exposes the
 *     shim path, not the secret. Same exposure surface as KUBECONFIG.
 *   - Tempfile + shim live in ~/.hsh/askpass/ which is created with mode
 *     0700 (parent dir already 0700 via getHshDir).
 *   - Filenames carry pid + 9 random hex bytes so two concurrent
 *     `hsh ssh` invocations from the same shell never collide.
 *   - The shim writes the token to its OWN stdout (which ssh reads). The
 *     token never touches the user's terminal.
 */

const ASKPASS_DIR = "askpass";
/**
 * Orphan TTL — files older than this are nuked by the sweeper. 5 minutes
 * is generous for any normal ssh handshake (the token is consumed
 * within milliseconds of askpass being invoked) but short enough that
 * a crashed hsh from earlier in the day leaves nothing behind.
 *
 * Pattern matches `sweepOrphanKubeconfigs` in plugins/kubeconfig.ts which
 * uses 24h — kubeconfigs hang around longer because they're tied to a
 * cached credential's lifetime; askpass files are single-shot.
 */
const ORPHAN_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Minimum OpenSSH version that honors `SSH_ASKPASS_REQUIRE=force`. Older
 * builds only invoke askpass when DISPLAY is set AND there's no TTY,
 * which is the opposite of what we want.
 *
 * Released Sept 2020. macOS 12+ ships ≥ 8.6 (Sonoma is 9.4). Linux
 * distros currently in support all carry 8.4+. The mechanism degrades
 * gracefully on older builds: askpass is silently ignored and ssh falls
 * back to the TTY password prompt — i.e. exactly today's UX.
 */
const MIN_OPENSSH_MAJOR = 8;
const MIN_OPENSSH_MINOR = 4;

export interface AskpassPair {
  /** Absolute path to the 0600 tempfile holding the raw token. */
  tokenPath: string;
  /** Absolute path to the 0700 shim that prints the token to stdout. */
  shimPath: string;
}

/**
 * Lazily create ~/.hsh/askpass/ at mode 0700.
 *
 * Mirrors the pattern in plugins/kubeconfig.ts so behavior is consistent.
 */
function getAskpassDir(): string {
  const dir = join(getHshDir(), ASKPASS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write a single-use askpass pair (token file + shim script).
 *
 * The shim is a 4-line shell script that:
 *   - sets a strict umask,
 *   - prints the token to stdout via `cat <tokenfile>` (NOT `echo $token`
 *     because that would put the token in the child env, defeating the
 *     whole point),
 *   - exits 0 even if the token file is missing (in which case ssh sees
 *     an empty password and fails normally with "Permission denied" —
 *     better than the shim itself failing with a confusing error).
 *
 * Returns absolute paths for both files. Caller is responsible for
 * `cleanupAskpassPair()` — typically in a `finally` block around the
 * spawned ssh process.
 */
export function writeAskpassPair(token: string): AskpassPair {
  const dir = getAskpassDir();
  const stem = `${process.pid}-${randHex(9)}`;
  const tokenPath = join(dir, `${stem}.token`);
  const shimPath = join(dir, `${stem}.sh`);

  // Token file: atomic write with explicit 0600. safeWrite handles fsync
  // and rename. We do NOT add a trailing newline — `cat` will preserve
  // bytes verbatim, and OpenSSH treats a trailing \n as part of the
  // password on some versions, which would silently auth-fail.
  safeWrite(tokenPath, token, { mode: 0o600 });

  // Shim: a minimal sh program. We avoid `printf '%s' "$tok"` because
  // that requires the token to live in env or argv, both of which would
  // leak via /proc/<pid>/cmdline or environ. `cat` of a 0600 file
  // keeps the secret off process listings entirely.
  //
  // We hardcode `/bin/sh` because every POSIX system has it; using
  // `#!/usr/bin/env sh` would add a fork that buys us nothing.
  const shimContent = [
    "#!/bin/sh",
    "# hsh askpass shim — generated, will be deleted on ssh exit.",
    "umask 077",
    `cat ${shellQuote(tokenPath)} 2>/dev/null || true`,
    "",
  ].join("\n");
  safeWrite(shimPath, shimContent, { mode: 0o700 });

  // safeWrite uses O_CREAT | O_EXCL with the requested mode, but some
  // umasks can mask out the executable bit on the rename. Force it back
  // to 0700 explicitly so ssh can actually exec the shim.
  chmodSync(shimPath, 0o700);

  debug("askpass", `pair written stem=${stem}`);
  return { tokenPath, shimPath };
}

/**
 * Single-quote a path for safe inclusion in a /bin/sh script. We use
 * `'...'` (no expansions inside) and double up any embedded apostrophes
 * the standard way: `it's` → `'it'\''s'`. Belt-and-braces — we generate
 * the path ourselves so it can only contain `[a-z0-9./-]`, but a future
 * refactor that lets users override the askpass dir mustn't break this.
 */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Best-effort cleanup. Errors are swallowed because at this point ssh
 * has already exited and there's nothing the user can do about a
 * permission glitch on a temp file in their own home directory. The
 * sweeper will pick up anything we miss.
 */
export function cleanupAskpassPair(pair: AskpassPair): void {
  for (const path of [pair.tokenPath, pair.shimPath]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

/**
 * Sweep ~/.hsh/askpass/ for orphan files older than ORPHAN_TTL_MS.
 *
 * Called on every `hsh ssh` invocation (cheap — the dir is tiny and
 * only this process writes to it). Same defensive pattern as
 * `sweepOrphanKubeconfigs` in plugins/kubeconfig.ts.
 *
 * The `now` parameter is injected for tests; production code calls
 * with the default.
 */
export function sweepOrphanAskpass(now: number = Date.now()): void {
  const dir = getAskpassDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".token") && !file.endsWith(".sh")) continue;
    const path = join(dir, file);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > ORPHAN_TTL_MS) {
        unlinkSync(path);
      }
    } catch {
      // best-effort — file may have been removed by a concurrent sweep,
      // or by the owning process's own cleanup
    }
  }
}

/**
 * Parse OpenSSH's `ssh -V` output (which prints to STDERR — that's a
 * decades-old quirk) into a major/minor pair.
 *
 * Real-world examples seen in the wild (covered by tests):
 *
 *   OpenSSH_9.6p1 Ubuntu-3ubuntu13.16, OpenSSL 3.0.13 ...
 *   OpenSSH_9.4p1, LibreSSL 3.3.6
 *   OpenSSH_8.4p1 Debian-5+deb11u3, OpenSSL 1.1.1w  ...
 *   OpenSSH_7.9p1 ...
 *   OpenSSH_for_Windows_8.6 ...                   (Windows OpenSSH)
 *   OpenSSH_8.0p1 portable, ...                    (pre-8.4 — refused)
 *
 * Returns null when the input doesn't look like OpenSSH at all (e.g.
 * Dropbear, libssh, an empty string). Pure function — exported for
 * tests.
 */
export function parseSshVersion(versionOutput: string): { major: number; minor: number } | null {
  // Match OpenSSH_<major>.<minor> with an optional "for_Windows_" or
  // similar between OpenSSH and the version. Anchor on OpenSSH_ to
  // reject Dropbear / libssh / random gibberish.
  const m = versionOutput.match(/OpenSSH(?:_for_[A-Za-z]+)?_(\d+)\.(\d+)/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/**
 * Decide whether the local OpenSSH is new enough to honor
 * `SSH_ASKPASS_REQUIRE=force`. Pure version comparison — separated
 * from the I/O so tests can drive every branch without spawning ssh.
 */
export function isVersionSupported(v: { major: number; minor: number } | null): boolean {
  if (!v) return false;
  if (v.major > MIN_OPENSSH_MAJOR) return true;
  if (v.major < MIN_OPENSSH_MAJOR) return false;
  return v.minor >= MIN_OPENSSH_MINOR;
}

/**
 * Detect the local ssh's version by spawning `ssh -V`. Cached for the
 * lifetime of the process — version doesn't change across a single
 * `hsh ssh` invocation, and the sub-process spawn is the only cost.
 *
 * Returns false if ssh isn't installed (ENOENT), if the version output
 * is unparseable, or if the version is too old. The askpass code path
 * is silently skipped in those cases and the legacy copy/paste UX
 * runs — same as if the user had set HSH_SSH_ASKPASS=0.
 */
let cachedSupport: boolean | undefined;
export function supportsAskpassRequireForce(): boolean {
  if (cachedSupport !== undefined) return cachedSupport;

  // `ssh -V` historically prints to STDERR, so we must capture both
  // streams. spawnSync gives us everything; execFileSync would force
  // a re-spawn for stderr.
  const res = spawnSync("ssh", ["-V"], { encoding: "utf-8" });
  if (res.error) {
    // ENOENT (ssh not installed) or EACCES — treat as unsupported.
    // The legacy copy/paste UX runs and the user gets a token they
    // can paste into whatever ssh-replacement they're using.
    debug("askpass", `ssh -V failed: ${res.error.message}`);
    cachedSupport = false;
    return false;
  }

  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const parsed = parseSshVersion(combined);
  const ok = isVersionSupported(parsed);

  debug(
    "askpass",
    `ssh -V parsed=${parsed ? `${parsed.major}.${parsed.minor}` : "null"} supported=${ok}`,
  );

  cachedSupport = ok;
  return ok;
}

/**
 * Test seam — clears the cached version detection so a single test run
 * can exercise both supported/unsupported branches. Not exported in the
 * public type definition; tests import it explicitly.
 */
export function _resetAskpassCacheForTest(): void {
  cachedSupport = undefined;
}

/**
 * Build the env vars to merge into the spawned ssh child. Pure function —
 * exported so the integration test can lock down the contract without
 * actually exec'ing anything.
 *
 *   SSH_ASKPASS         absolute path to the shim
 *   SSH_ASKPASS_REQUIRE "force"  — required for ssh to use askpass when
 *                       a TTY is available (default behavior is "prefer"
 *                       which means TTY wins).
 *   DISPLAY             ":0"     — askpass historically required X11.
 *                       The value is irrelevant; ssh just checks it's
 *                       set to SOMETHING. We pick :0 because some old
 *                       guides reference it; "dummy" works equally well.
 *
 * We deliberately do NOT clear the user's existing env. The caller is
 * expected to spread `process.env` first and let our keys override the
 * three we set — see `withAskpassEnv()` below.
 */
export function buildAskpassEnv(shimPath: string): Record<string, string> {
  return {
    SSH_ASKPASS: shimPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY && process.env.DISPLAY !== "" ? process.env.DISPLAY : ":0",
  };
}

/**
 * Convenience: take the parent's env and overlay askpass keys for the
 * spawned child. The parent's own env is unaffected — only the child
 * inherits these values.
 */
export function withAskpassEnv(
  parentEnv: NodeJS.ProcessEnv,
  shimPath: string,
): NodeJS.ProcessEnv {
  return { ...parentEnv, ...buildAskpassEnv(shimPath) };
}

/**
 * The opt-out env var. Default is ENABLED — see ENG-360 / decision doc.
 *
 *   HSH_SSH_ASKPASS=0    → forced off, copy-paste UX runs
 *   HSH_SSH_ASKPASS=off  → same
 *   anything else / unset → enabled (subject to version detection)
 *
 * Single source of truth so the rollout flip is one constant.
 */
export function isAskpassEnabled(): boolean {
  const v = process.env.HSH_SSH_ASKPASS;
  if (v === undefined) return true;
  const lower = v.trim().toLowerCase();
  // Recognise common "off" spellings. Anything else (including "1",
  // "true", "yes", "") means enabled.
  return !["0", "off", "false", "no"].includes(lower);
}
