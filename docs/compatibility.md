# Tool compatibility

`hsh` integrates with `ssh` and `kubectl` via shell functions defined by `hsh shell-init`. Tools that **invoke `ssh`/`kubectl` as a subprocess bypass those functions** — they look up the binary on `PATH` and don't see the alias.

This document is the canonical answer to *"does \<tool\> work with hsh?"*.

## TL;DR

| Tool                                | ssh-routed? | kubectl-routed? | Notes                                                                      |
|-------------------------------------|-------------|-----------------|----------------------------------------------------------------------------|
| `ssh hostname`                      | ✓           | —               | Direct shell-function path.                                                |
| `command ssh hostname`              | passthrough | —               | Bypasses the function intentionally; runs system `ssh`.                    |
| `git push` over ssh                 | ✓           | —               | `GIT_SSH_COMMAND="hsh plugin run ssh --"` set by `hsh shell-init`.         |
| `rsync -e ssh ...`                  | ✓           | —               | `RSYNC_RSH="hsh plugin run ssh --"` set by `hsh shell-init`.               |
| `scp` / `sftp`                      | ✗           | —               | No env-var hook; bypasses hsh entirely. **Workaround**: use ssh + `tar` pipes, or set `KUBECONFIG`-equivalent env vars (none exist). |
| `kubectl get pods`                  | —           | ✓               | Direct shell-function path.                                                |
| `command kubectl ...`               | —           | passthrough     | Bypasses the function intentionally.                                       |
| `helm install foo ./chart`          | —           | ✗ by default    | helm spawns kubectl directly. **Workaround**: see *KUBECONFIG workflow* below. |
| `kustomize build . \| kubectl apply -f -` | —     | ✓ on the right side | The `\| kubectl` part goes through the shell function.                |
| `k9s`                               | —           | ✗ by default    | Reads kubeconfig directly via Go client-go. **Workaround**: KUBECONFIG.    |
| `Lens` (desktop app)                | —           | ✗ by default    | Reads kubeconfig at startup, doesn't see the function. **Workaround**: KUBECONFIG. |
| `skaffold dev`                      | —           | ✗ by default    | Long-lived; spawns kubectl directly. **Workaround**: KUBECONFIG, but see expiry caveat. |
| `kubectx` / `kubens`                | —           | ✓ for switching | They edit kubeconfig directly; `hsh kubectl` then reads the new context.   |

✓ = works out of the box, hsh routes the call.
✗ = bypasses hsh, see the workaround.
passthrough = goes to system ssh/kubectl (not Hoop).

## KUBECONFIG workflow (for helm, k9s, Lens, skaffold, etc.)

The general fix for any tool that bypasses the kubectl shell function is to feed it a kubeconfig that points at the Hoop proxy. `hsh kubeconfig <connection>` does exactly that:

```bash
# One-shot: helm against a Hoop connection
export KUBECONFIG="$(hsh kubeconfig prod-cluster)"
helm install foo ./chart

# Same idea for k9s, Lens via launcher, kustomize+kubectl-apply, etc.
KUBECONFIG="$(hsh kubeconfig prod-cluster)" k9s

# Merge with your existing KUBECONFIG so other contexts stay reachable
export KUBECONFIG="$(hsh kubeconfig --merge prod-cluster)"
```

`hsh kubeconfig`:
- Authenticates if needed (re-uses cached token; does the OAuth dance if expired).
- Issues credentials against the named Hoop connection (re-uses cached credentials when fresh).
- Writes the ephemeral kubeconfig at `~/.hsh/kube/<connection>.yaml` (mode 0600, atomic write).
- Prints **just the path** on stdout. Everything else goes to stderr so `KUBECONFIG=$(...)` capture stays clean.

Exit codes match the kubectl plugin's contract: `0` success, `1` generic failure, `75` (`EX_TEMPFAIL`) when the connection requires approval. See [`docs/troubleshooting.md`](troubleshooting.md) for the full table.

### Long-lived processes (skaffold, k9s session, Lens watching contexts)

The credentials embedded in the kubeconfig have a TTL (default 1 hour, set by Hoop). When they expire, your long-running tool will start getting `401`s from the proxy. Two options:

1. **Restart the tool** with a fresh `hsh kubeconfig <connection>` — easiest, works for k9s and most one-shot helm/skaffold flows.
2. **Re-issue and let the tool re-read** — `hsh kubeconfig <connection>` writes to the same `~/.hsh/kube/<connection>.yaml` path each time. Tools that re-read kubeconfig periodically (Lens does, k9s sometimes does) will pick up the new token without restart. Tools that read once at startup (skaffold) need a restart.

Long-running scenarios are not auto-refreshed today. The cleanest fix would be a refresh-token loop in hsh ([ENG-349](https://linear.app/hoophq/issue/ENG-349) covers JWT refresh; the credential-issuance refresh is a separate piece of work).

## SSH-wrapping tools

`hsh shell-init` exports:

```sh
export GIT_SSH_COMMAND="hsh plugin run ssh --"
export RSYNC_RSH="hsh plugin run ssh --"
```

These cover `git`, `rsync`, and most ssh-using build tools that respect `GIT_SSH_COMMAND` (e.g. `bundler`, `cargo` for git deps, `pip install git+ssh://`). For tools that don't:

| Tool                         | Workaround                                                                              |
|------------------------------|----------------------------------------------------------------------------------------|
| `scp`, `sftp`                | None — they go directly to `/usr/bin/ssh`. Use `ssh ... 'cat > /tmp/file' < ./file` patterns. |
| `mosh`                       | Uses ssh for handshake but switches to UDP. Usually works for the handshake; Hoop can't proxy the UDP. |
| `vscode` Remote-SSH         | VS Code spawns `ssh` directly. Set `remote.SSH.path` in settings to the absolute path of the hsh shim if you want hsh routing, OR make the host an alias in `~/.ssh/config` (which works as ssh passthrough). |
| `ansible-playbook`          | Set `ANSIBLE_SSH_EXECUTABLE=$(which hsh-ssh-shim)` if you want routing. Otherwise it bypasses. |

## Known sharp edges

### `KUBECONFIG` already set by another tool

If the user (or a tool like `kind`, `minikube`, `k3d`, or VS Code's Remote-Containers) has already set `KUBECONFIG`, the kubectl plugin merges hsh's ephemeral file FIRST in the colon-separated list. The Hoop entry wins precedence. Other contexts in the user's pre-existing `KUBECONFIG` remain reachable via `--context=<other-name>`.

This is verified by [`tests/multi-cluster.integration.test.ts`](../tests/multi-cluster.integration.test.ts) (the *merged KUBECONFIG with hsh + user-config* case).

### Stale kubeconfig files

`~/.hsh/kube/<connection>.yaml` is sweep-cleaned at 24h TTL on every kubectl invocation (see [`src/plugins/kubeconfig.ts`](../src/plugins/kubeconfig.ts) `sweepOrphanKubeconfigs`). `hsh logout` wipes them all. If `helm` / `k9s` etc. are long-running and outlive the TTL, their captured `KUBECONFIG` value still points at a path that may be deleted underneath them — they'll start failing with config-not-found errors. Restart the tool after `hsh logout`.

### `command kubectl` and absolute-path kubectl

These bypass the shell function deliberately. `command kubectl get pods` and `/usr/local/bin/kubectl get pods` go to system kubectl with whatever `~/.kube/config` says. **They will not be Hoop-routed** unless you also have a Hoop entry in `~/.kube/config` — which hsh deliberately doesn't add ([ENG-343](https://linear.app/hoophq/issue/ENG-343)). To bypass-and-still-Hoop-route, use the `KUBECONFIG="$(hsh kubeconfig <conn>)"` workflow.

## Summary

For any kubectl-using tool that doesn't go through the shell function, the answer is **`KUBECONFIG="$(hsh kubeconfig <connection>)"`**. This single env var threads the Hoop proxy through every tool that respects `KUBECONFIG`, which is essentially all of them.

For ssh-using tools, `GIT_SSH_COMMAND` and `RSYNC_RSH` cover the common cases. Niche tools (`scp`, `mosh`, IDE remote-ssh integrations) currently bypass and go to system ssh — file an issue if your workflow depends on Hoop routing for one of them.
