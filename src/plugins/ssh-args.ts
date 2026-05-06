/**
 * Single canonical OpenSSH argument parser shared by `extractHostname` and
 * `rewriteArgs`. Models the SYNOPSIS in `man ssh(1)`, with conservative
 * fall-through behavior for unknown flags.
 *
 * This module is pure (no I/O, no side effects) so the test suite can pin
 * golden cases against it without a fixture.
 */

/**
 * OpenSSH short flags that DO take a following value. Sourced from the
 * `man ssh(1)` SYNOPSIS line. Long-form (`--foo`) is not used by ssh(1).
 */
const SHORT_FLAGS_WITH_VALUE = new Set([
  "-B", "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
  "-L", "-l", "-m", "-O", "-o", "-P", "-p", "-Q", "-R", "-S",
  "-W", "-w",
]);

/**
 * OpenSSH short flags that DO NOT take a value (boolean toggles). These are
 * also commonly stacked, e.g. `-vvv` or `-AY`. Listed for completeness even
 * though the parser accepts unknown short flags as valueless.
 */
const SHORT_FLAGS_BOOLEAN = new Set([
  "-4", "-6", "-A", "-a", "-C", "-f", "-G", "-g", "-K", "-k",
  "-M", "-N", "-n", "-q", "-s", "-T", "-t", "-V", "-v", "-X",
  "-x", "-Y", "-y",
]);

/** Visible solely for unit tests. */
export const _internals = {
  SHORT_FLAGS_WITH_VALUE,
  SHORT_FLAGS_BOOLEAN,
};

export type SshToken =
  /** Standalone valueless flag (e.g. `-v`, `-4`, or unknown short flag). */
  | { kind: "flag"; value: string }
  /** Flag + value pair. `joined=true` for `-pX`/`-i/path`; false for `-p X`. */
  | { kind: "flag-value"; flag: string; value: string; joined: boolean }
  /** `-o KEY=VAL` (joined=false) or `-oKEY=VAL` (joined=true). */
  | { kind: "option"; key: string; value: string; joined: boolean }
  /** First positional — the destination, possibly `user@host` or URI form. */
  | { kind: "destination"; user: string | null; host: string }
  /** A literal `--` end-of-options marker. */
  | { kind: "double-dash" }
  /**
   * Remote command and its arguments — everything after the destination
   * (or after `--`). Preserved as-is and never rewritten.
   */
  | { kind: "command"; value: string };

export interface ParsedSshArgs {
  /** Effective user from `-l` or `user@host` (the latter wins only if no `-l`). */
  user: string | null;
  /** Effective hostname (without user prefix). */
  host: string | null;
  /** Effective port from `-p`, `-pNN`, `-o Port=NN`, or URI form. */
  port: string | null;
  /** Token stream in input order — feeds `rewriteSshArgs`. */
  tokens: SshToken[];
}

/**
 * Parse an argv slice (after the `ssh` argv[0]) into structured tokens plus
 * the resolved user/host/port.
 *
 * Unknown short flags are treated as valueless and the parser continues —
 * this matches OpenSSH's "we'll error later" behavior and is the only safe
 * default for a passthrough wrapper.
 */
export function parseSshArgs(args: string[]): ParsedSshArgs {
  const tokens: SshToken[] = [];
  let userFromL: string | null = null;
  let userFromDest: string | null = null;
  let host: string | null = null;
  let portFromFlag: string | null = null;
  let portFromOpt: string | null = null;
  let portFromUri: string | null = null;

  let i = 0;
  let destSeen = false;
  let doubleDashSeen = false;

  while (i < args.length) {
    const arg = args[i];

    // Anything past `--` (other than the destination immediately after) is
    // a remote command. The destination itself may also appear before `--`.
    if (doubleDashSeen) {
      // After `--`, the very next token is the destination if we haven't
      // seen one yet, otherwise it's the remote command.
      if (!destSeen) {
        const { user, host: h } = splitDestination(arg);
        userFromDest = user;
        host = h;
        if (h && !portFromUri) {
          // splitDestination already populated portFromUri-equivalent inline
          // — handled below via the URI path. For non-URI dest this is a
          // no-op.
        }
        tokens.push({ kind: "destination", user, host: h });
        destSeen = true;
      } else {
        tokens.push({ kind: "command", value: arg });
      }
      i++;
      continue;
    }

    if (arg === "--") {
      tokens.push({ kind: "double-dash" });
      doubleDashSeen = true;
      i++;
      continue;
    }

    // Already past the destination → everything else is the remote command.
    if (destSeen) {
      tokens.push({ kind: "command", value: arg });
      i++;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      // -o KEY=VAL  or  -oKEY=VAL
      if (arg === "-o" && i + 1 < args.length) {
        const raw = args[i + 1];
        const eq = raw.indexOf("=");
        const key = eq >= 0 ? raw.slice(0, eq) : raw;
        const value = eq >= 0 ? raw.slice(eq + 1) : "";
        tokens.push({ kind: "option", key, value, joined: false });
        if (key.toLowerCase() === "port") portFromOpt = value;
        i += 2;
        continue;
      }
      if (arg.startsWith("-o") && arg.length > 2) {
        const raw = arg.slice(2);
        const eq = raw.indexOf("=");
        const key = eq >= 0 ? raw.slice(0, eq) : raw;
        const value = eq >= 0 ? raw.slice(eq + 1) : "";
        tokens.push({ kind: "option", key, value, joined: true });
        if (key.toLowerCase() === "port") portFromOpt = value;
        i++;
        continue;
      }

      // Known short flag with separate value: `-p 22`, `-i /path`, ...
      if (SHORT_FLAGS_WITH_VALUE.has(arg)) {
        if (i + 1 < args.length) {
          const value = args[i + 1];
          tokens.push({ kind: "flag-value", flag: arg, value, joined: false });
          if (arg === "-p") portFromFlag = value;
          if (arg === "-l") userFromL = value;
          i += 2;
        } else {
          // Dangling flag with no value — leave as-is and let ssh complain.
          tokens.push({ kind: "flag", value: arg });
          i++;
        }
        continue;
      }

      // Joined short flag with value: `-p22`, `-i/path/key`, `-l alice`-as-`-lalice`.
      // Detected by checking if the 2-char prefix is a known value-taking flag.
      const prefix = arg.slice(0, 2);
      if (SHORT_FLAGS_WITH_VALUE.has(prefix) && arg.length > 2) {
        const value = arg.slice(2);
        tokens.push({ kind: "flag-value", flag: prefix, value, joined: true });
        if (prefix === "-p") portFromFlag = value;
        if (prefix === "-l") userFromL = value;
        i++;
        continue;
      }

      // Boolean flag (`-v`, `-4`) OR stacked booleans (`-vvv`, `-AY`) OR
      // unknown short flag → emit verbatim, no value consumed.
      tokens.push({ kind: "flag", value: arg });
      i++;
      continue;
    }

    // Bare positional → destination (first occurrence) or command (rest).
    if (!destSeen) {
      const parsed = splitDestination(arg);
      userFromDest = parsed.user;
      host = parsed.host;
      if (parsed.port) portFromUri = parsed.port;
      tokens.push({ kind: "destination", user: parsed.user, host: parsed.host });
      destSeen = true;
    } else {
      tokens.push({ kind: "command", value: arg });
    }
    i++;
  }

  // -l takes precedence over user@host per OpenSSH semantics.
  const user = userFromL ?? userFromDest;
  // -p takes precedence over -o Port= per OpenSSH (last-set-on-command-line).
  // URI form is least authoritative.
  const port = portFromFlag ?? portFromOpt ?? portFromUri;

  return { user, host, port, tokens };
}

/**
 * Split a destination token into (user, host, port?). Accepts:
 *   - `host`
 *   - `user@host`
 *   - `ssh://[user@]host[:port]`  (RFC-ish URI form documented in `man ssh`)
 */
function splitDestination(
  raw: string,
): { user: string | null; host: string; port: string | null } {
  if (raw.startsWith("ssh://")) {
    const rest = raw.slice("ssh://".length);
    const at = rest.indexOf("@");
    const userPart = at >= 0 ? rest.slice(0, at) : null;
    const hostAndPort = at >= 0 ? rest.slice(at + 1) : rest;
    // Bracketed IPv6: [::1]:22
    if (hostAndPort.startsWith("[")) {
      const close = hostAndPort.indexOf("]");
      if (close >= 0) {
        const host = hostAndPort.slice(1, close);
        const after = hostAndPort.slice(close + 1);
        const port = after.startsWith(":") ? after.slice(1) || null : null;
        return { user: userPart, host, port };
      }
    }
    const colon = hostAndPort.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(hostAndPort.slice(colon + 1))) {
      return {
        user: userPart,
        host: hostAndPort.slice(0, colon),
        port: hostAndPort.slice(colon + 1),
      };
    }
    return { user: userPart, host: hostAndPort, port: null };
  }

  const at = raw.indexOf("@");
  if (at >= 0) {
    return { user: raw.slice(0, at), host: raw.slice(at + 1), port: null };
  }
  return { user: null, host: raw, port: null };
}

export interface RewriteOpts {
  /** Username for the Hoop gateway (replaces user@host and any `-l`). */
  newUser: string;
  /** Hostname for the Hoop gateway. */
  newHost: string;
  /** Port for the Hoop gateway. */
  newPort: string;
}

/**
 * Render a token stream back to argv, substituting destination + injecting
 * `-p newPort` exactly once. All other flags/options/commands are preserved.
 *
 * Drops:
 *   - `-l user` (the gateway user is forced via `newUser@newHost`)
 *   - `-p NN` and `-o Port=NN` (replaced with a single `-p newPort`)
 *   - URI-embedded port (the destination is rewritten to bare `user@host`)
 *
 * Keeps:
 *   - All other flags, options, and the remote command verbatim.
 *   - `--` end-of-options marker if it was present.
 */
export function rewriteSshArgs(
  parsed: ParsedSshArgs,
  opts: RewriteOpts,
): string[] {
  const out: string[] = [];
  out.push("-p", opts.newPort);

  for (const t of parsed.tokens) {
    switch (t.kind) {
      case "flag":
        out.push(t.value);
        break;

      case "flag-value":
        if (t.flag === "-p" || t.flag === "-l") break; // dropped
        if (t.joined) {
          out.push(`${t.flag}${t.value}`);
        } else {
          out.push(t.flag, t.value);
        }
        break;

      case "option":
        if (t.key.toLowerCase() === "port") break; // dropped
        if (t.joined) {
          out.push(`-o${t.key}=${t.value}`);
        } else {
          out.push("-o", `${t.key}=${t.value}`);
        }
        break;

      case "destination":
        out.push(`${opts.newUser}@${opts.newHost}`);
        break;

      case "double-dash":
        out.push("--");
        break;

      case "command":
        out.push(t.value);
        break;
    }
  }

  return out;
}
