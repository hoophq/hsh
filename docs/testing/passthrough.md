# SSH passthrough fidelity test matrix

When `hsh` decides a target is **not** a Hoop connection, it falls through to native `ssh` and the user's invocation must behave **byte-identically** to running `ssh` directly. The argv-fidelity portion of this contract is locked down by automated tests in [`tests/ssh-passthrough.test.ts`](../../tests/ssh-passthrough.test.ts) — those run on every PR and cover ~30 invocation forms.

This document is the **manual** counterpart. The scenarios below depend on real SSH servers, `~/.ssh/config` files, and external tooling (git, rsync, scp), so they're not in CI. Run through them before each release.

## When passthrough is triggered

`hsh` falls through to native `ssh` when **any** of these apply:

1. The argv has no parseable hostname (e.g. `ssh -V`, `ssh -h`, dangling flags).
2. The configured `api-url` is unset or returns an unreachable error within ~3s ([ENG-353](https://linear.app/hoophq/issue/ENG-353)).
3. The user is not authenticated (`hsh login` was never run, or the token expired and refresh failed).
4. The hostname doesn't match any Hoop connection at the `exact`, `exact-short`, `schema-field`, or `tag` level — see [`docs/connection-matching.md`](../connection-matching.md). There is no substring fallback.

In every passthrough case, `hsh` invokes `spawn("ssh", argv, { stdio: "inherit" })` with the original argv unchanged, no env override, no cwd override.

## Setup

Most cases below use placeholder hostnames. Wire them to whatever you have:

```bash
# A real SSH host (anything that accepts your key)
export TEST_HOST="myserver.internal.example.com"

# A jump host for ProxyJump tests
export TEST_JUMP="bastion.example.com"

# A user that exists on TEST_HOST
export TEST_USER="alice"

# Make sure hsh is NOT installed as an alias OR ensure the connection
# 'myserver.internal.example.com' does NOT exist in your Hoop instance.
# Run `hsh status` to confirm the API URL is reachable; otherwise every
# command below will trigger fail-open passthrough by default.
```

## Test matrix

For each row below: **run the command both with `hsh shell-init` active and with `command ssh ...` (which bypasses the alias).** The behavior, exit code, output, and any side effects (control sockets, host key prompts) must match.

### A. Plain ssh

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 1 | `ssh $TEST_HOST`                                       | Interactive shell. `$?=0` on clean exit.            |
| 2 | `ssh $TEST_USER@$TEST_HOST`                            | Same as #1, logged in as $TEST_USER.                |
| 3 | `ssh -p 22 $TEST_HOST`                                 | Same as #1.                                         |
| 4 | `ssh $TEST_HOST hostname`                              | Prints remote hostname. `$?=0`.                     |
| 5 | `ssh $TEST_HOST exit 7`                                | `$?=7`. (Exit-code propagation; see [ENG-348](https://linear.app/hoophq/issue/ENG-348).) |

### B. ssh_config interactions

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 6 | `ssh my-alias` (define `my-alias` in `~/.ssh/config`)  | Resolves alias. Same shell as direct ssh would give. |
| 7 | `ssh -F /tmp/alt-ssh-config $TEST_HOST`                | Uses the alt config. Verify by setting an alias only in the alt file. |
| 8 | `ssh -o "PreferredAuthentications=publickey" $TEST_HOST` | Same as #1; option flows through.                |

### C. ProxyJump

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 9 | `ssh -J $TEST_JUMP $TEST_HOST`                         | Connects via jump host.                             |
| 10| `ssh -J $TEST_USER@$TEST_JUMP $TEST_HOST`              | Same, with explicit jump-host user.                 |
| 11| `ssh -J $TEST_JUMP,$TEST_HOST another-host`            | Multi-hop chain works.                              |

### D. ControlMaster (multiplexing)

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 12| `ssh -o "ControlMaster=auto" -o "ControlPath=/tmp/.mux-%C" -o "ControlPersist=10m" $TEST_HOST exit` | Creates `/tmp/.mux-<hash>`. Visible with `ls /tmp/.mux-*`. |
| 13| Run #12 again immediately. Look at the timestamp.      | Reuses the existing socket (faster connect; no new pty negotiation). |
| 14| `ssh -O exit -o "ControlPath=/tmp/.mux-%C" $TEST_HOST` | Closes the socket. `ls /tmp/.mux-*` shows it gone.  |

### E. Key + identity

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 15| `ssh -i ~/.ssh/id_ed25519 $TEST_HOST`                  | Uses that specific key.                             |
| 16| `ssh-add -L && ssh -A $TEST_HOST 'ssh-add -L'`         | Agent forwarding; remote sees the same keys.        |

### F. Tunnels

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 17| `ssh -L 18080:localhost:80 $TEST_HOST`                 | Connect, then `curl localhost:18080` from another shell hits the remote's `localhost:80`. |
| 18| `ssh -R 19090:localhost:9090 $TEST_HOST`               | Remote can `curl localhost:19090` and reach our local 9090. |
| 19| `ssh -D 11080 $TEST_HOST` then `curl --socks5 localhost:11080 https://example.com` | SOCKS proxy works.                  |

### G. SSH-wrapping tools

`hsh shell-init` exports:

```sh
export GIT_SSH_COMMAND="hsh plugin run ssh --"
export RSYNC_RSH="hsh plugin run ssh --"
```

So `git` and `rsync` route their internal ssh invocations through the wrapper. `scp` / `sftp` do not (no equivalent env-var hook), and they invoke `ssh` directly via PATH — which means they bypass the shell function and go to the system `ssh` unconditionally.

| #  | Command                                                | Expectation                                                  |
|----|--------------------------------------------------------|--------------------------------------------------------------|
| 20 | `git clone git@github.com:some/repo.git`               | Clones successfully (passthrough since github.com isn't a Hoop connection). |
| 21 | `git push` (against an ssh-remote)                     | Pushes successfully.                                         |
| 22 | `GIT_SSH_COMMAND="ssh -vv" git fetch`                  | User's explicit override wins; `-vv` output appears.         |
| 23 | `rsync -avz src/ $TEST_HOST:/tmp/dst/`                 | Files transfer.                                              |
| 24 | `rsync -e "ssh -p 22" src/ $TEST_HOST:/tmp/dst/`       | User's `-e` override wins; passthrough still byte-identical. |
| 25 | `scp localfile $TEST_HOST:/tmp/`                       | Copies successfully (modern scp uses sftp protocol — pipeline must be intact). **Bypasses hsh entirely**, so this just verifies system ssh is on PATH. |
| 26 | `sftp $TEST_HOST` then `put localfile`                 | sftp shell works. **Also bypasses hsh entirely.**            |

### H. Alias-bypass

| # | Command                                                | Expectation                                         |
|---|--------------------------------------------------------|-----------------------------------------------------|
| 27| `command ssh $TEST_HOST`                               | Bypasses the hsh shell function. Direct ssh runs.   |
| 28| `\ssh $TEST_HOST` (backslash-prefix bypass in bash/zsh)| Same as #27.                                        |
| 29| `/usr/bin/ssh $TEST_HOST` (absolute path bypass)       | Same as #27.                                        |

For these alias-bypass cases, hsh is not in the loop at all — they exist to verify the **shell-init function** definition doesn't override `command`/absolute-path lookups (it shouldn't; the function only intercepts the bare `ssh` name).

## Drift triage

If any case above produces different behavior between `hsh`-routed passthrough and direct ssh:

1. Capture a `HSH_DEBUG=1` trace alongside the failing command.
2. Check whether it's an argv issue (compare `[hsh debug] ssh: argv parsed` against the input) — most drift would be caught by the unit tests, but a live SSH server may surface platform-specific quirks.
3. File a separate bug. Reference this checklist row.

## Release-checklist hook

Add a line to your release checklist:

```markdown
- [ ] Run docs/testing/passthrough.md cases against staging SSH host (~15 minutes)
```

Skipping is fine for hotfix releases that don't touch `src/plugins/ssh.ts`, `src/plugins/ssh-args.ts`, or the shell-init function. Re-run on any PR that does.
