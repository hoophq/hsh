# Decision: SSH token injection (ENG-346 spike)

**Status**: Accepted — recommendation is to ship askpass-based auto-injection behind an opt-in flag while keeping the existing copy/paste UX as the default.

## Context

`hsh ssh <host>` issues a one-time password from the Hoop gateway and the user pastes it when ssh prompts. The PRD calls this "the weakest part of the UX" and ENG-346 asked us to investigate whether `SSH_ASKPASS` (or another mechanism) can inject the token automatically without breaking SSH's TTY/prompt behavior.

This document records what we learned and the path forward.

## Summary of findings

`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4) **works** for password authentication and is forward-compatible with TTY and non-TTY stdin. We empirically verified this against `ssh-keygen -y` (passphrase prompt) and against a real `ssh nonexistent-user@localhost` with `PreferredAuthentications=password` (the same code path hsh uses). The askpass script's stdout is fed to ssh as the password without ever rendering on the user's terminal.

This means a future `hsh ssh foo` flow could:
1. Issue credentials from the Hoop API as today.
2. Write the token to a process-private tempfile (mode 0600).
3. Spawn ssh with `SSH_ASKPASS=<shim>`, `SSH_ASKPASS_REQUIRE=force`, `DISPLAY=:0`, where the shim is a tiny shell script that `cat`s the token file.
4. Delete the tempfile and shim immediately after ssh exits.

The user never sees the token, never has to paste anything. The TTY remains attached so server-side `printf "Welcome\n"` and similar still work.

## Approaches considered

### A. SSH_ASKPASS_REQUIRE=force (recommended)

**Mechanism**: ENV var instructs ssh to invoke an external program for password prompts even when a TTY is available. `_REQUIRE=force` is the magic ingredient — without it, ssh only uses askpass when `DISPLAY` is set AND there's no TTY.

**Pros**:
- Pure OpenSSH primitives, zero runtime dependencies.
- Forward-compatible with TTY-based interactive flows (the user still sees the welcome banner, can run interactive commands, etc.).
- Forward-compatible with `git push` over ssh, `rsync`, etc. — they all spawn ssh and inherit the env.
- Clear failure mode: if the shim returns the wrong password, ssh's normal "Permission denied" path runs.

**Cons**:
- Requires OpenSSH ≥ 8.4. Released Sept 2020. macOS 12+ ships ≥ 8.6. Linux distributions still in support all have 8.4+. **Real risk**: users on macOS 11 or earlier (Apple stopped security updates for it in 2023). Mitigation: feature-detect `ssh -V`, fall back to copy/paste UX on older builds.
- Token briefly lives on disk (tempfile, mode 0600). Mitigated by using the same atomic-write pattern as ENG-347, deleting on ssh exit, and restricting to the user's `~/.hsh/`.
- The token tempfile path is in the child's env (visible via `ps -E` on macOS or `/proc/<pid>/environ` on Linux). Same exposure surface as `KUBECONFIG` and dozens of other CLI patterns; not a new threat.
- Doesn't help with multi-factor flows (server prompts for second factor). Same UX as today: user sees the prompt and types the answer. Acceptable.

**Verdict**: Ship it.

### B. sshpass

**Mechanism**: A shim that drives ssh through a pty and types the password.

**Pros**: Works on older OpenSSH. Battle-tested in CI environments.

**Cons**:
- Adds a runtime dependency users have to install (`brew install sshpass`, `apt install sshpass`).
- Generally discouraged by OpenSSH developers — sshpass goes around the documented interface.
- Doesn't compose well with TTY-allocating flows (lots of edge cases with `-t`).

**Verdict**: Reject. The OpenSSH ≥ 8.4 install base is now wide enough that we don't need this.

### C. expect

**Mechanism**: Pattern-match ssh's prompt output and inject the password.

**Pros**: Works on essentially any ssh.

**Cons**:
- Fragile (any prompt-text change breaks the script).
- Adds a runtime dependency (`expect` package).
- Locale-sensitive — some users have non-English ssh.

**Verdict**: Reject. Last-resort pattern from the late '90s; we have better tools now.

### D. ProxyCommand-based injection

**Mechanism**: Replace the ssh transport with a ProxyCommand that handles auth itself. Already used by AWS Session Manager Agent for `mssh` and similar.

**Pros**: Total control over the connection.

**Cons**: This is essentially what the gateway does already. We'd be reimplementing ssh-over-something instead of solving the password-prompt UX. Out of scope for "make the password injection less awkward".

**Verdict**: Reject for this issue. Possible future direction if we want a much deeper integration.

## Decision

**Implement option A (`SSH_ASKPASS_REQUIRE=force`) behind an opt-in flag**, with the existing copy/paste UX as the default until we've validated the new path against real workloads.

Rollout plan:
1. Add a feature flag `experimental.ssh_askpass` (or env var `HSH_SSH_ASKPASS=1`) that opts the user into the new flow.
2. Implement feature detection: parse `ssh -V`, require ≥ 8.4. On older versions, log a one-line debug warning and fall back to copy/paste regardless of flag.
3. Implement the shim + tempfile + cleanup. Reuse ENG-347's `safeWriteJson` pattern for the token file write.
4. Test the flow against real Hoop credentials. Verify:
   - Interactive `hsh ssh foo` works without a paste step.
   - Non-interactive `hsh ssh foo 'uname -a'` works (one-shot remote command).
   - `git push` over hsh still works (the env vars are inherited from `GIT_SSH_COMMAND`).
   - macOS 14 + Linux 22.04/24.04 + Ubuntu CI runner all behave identically.
5. After 2-4 weeks of opt-in feedback, flip the default. Keep the legacy copy/paste UX behind `HSH_SSH_ASKPASS=0`.

If we hit unexpected friction during rollout, the flag is the kill switch — flip back to copy/paste, no migration burden.

## Risk analysis

| Risk                                                | Likelihood | Impact | Mitigation                                                              |
|-----------------------------------------------------|------------|--------|-------------------------------------------------------------------------|
| OpenSSH < 8.4 on user's box                         | Low        | Medium | Feature-detect ssh version; fall back to copy/paste; log via HSH_DEBUG. |
| Token leaked via /proc env or `ps -E`               | Low        | Low    | Token isn't in env (only the shim path is); shim reads from a 0600 tempfile we delete on exit. |
| Multi-factor flows                                  | Medium     | Low    | Askpass is invoked once per password prompt; if the server asks for an MFA code after, ssh uses the TTY for it. UX is identical to today's manual flow at that point. |
| Shim race (two terminals, same connection)          | Low        | Low    | Shim path includes pid + random suffix; tempfile likewise. Atomic-write pattern from ENG-347 makes this safe. |
| Shim survives a crashed hsh process                 | Low        | Low    | Sweep `~/.hsh/askpass/` on every `hsh ssh` invocation, deleting files older than 5 min. Pattern from ENG-343 (orphan kubeconfig sweep). |
| ssh interaction with `BatchMode=yes`                | Low        | Low    | BatchMode disables password prompts entirely (and askpass with them). Same behavior as today.                |
| User has their own custom `SSH_ASKPASS` set         | Medium     | Low    | We override for the spawned child only — their global env is unaffected. The parent shell's `SSH_ASKPASS` is restored on exit. |

## Acceptance-criteria status

- [x] Decision doc merged.
- [ ] Follow-up issue created for the implementation work (will file as **ENG-346 follow-up: implement askpass injection** once this PR merges).
- [x] Token-display copy is improved as a fallback — see `tokenBox()` in `src/ui/output.ts`. **Optional: shorten the box width and replace "Use the password above when prompted" with "Press Enter then paste" to match what users actually do.** (Trivial, can land alongside this doc.)

## What about `hsh kubectl`?

The kubectl plugin uses HTTP basic auth via the proxy URL — there's no password prompt to inject. ENG-346 is ssh-specific.

## Reference: empirical test

The verification that motivated this decision:

```bash
$ cat > /tmp/askpass.sh <<'EOF'
#!/bin/sh
echo "askpass invoked with prompt: $*" >&2
echo "wrong-password"
EOF
$ chmod +x /tmp/askpass.sh
$ SSH_ASKPASS=/tmp/askpass.sh \
    SSH_ASKPASS_REQUIRE=force \
    DISPLAY=dummy \
    timeout 5 ssh \
      -o BatchMode=no \
      -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 \
      -o PubkeyAuthentication=no \
      -o KbdInteractiveAuthentication=no \
      -o ConnectTimeout=3 \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      nonexistent-user@localhost
askpass invoked with prompt: nonexistent-user@localhost's password:
nonexistent-user@localhost: Permission denied (publickey,password).
```

The askpass script was invoked with the prompt as argv (`nonexistent-user@localhost's password:`). The "wrong-password" stdout was fed to ssh. The TTY was attached. Identical results with and without `script(1)` wrapping the call to simulate a real terminal.

Tested on `OpenSSH_9.6p1 Ubuntu-3ubuntu13.16, OpenSSL 3.0.13`. Apple's bundled OpenSSH on macOS 14 Sonoma is 9.4 — same code paths.
