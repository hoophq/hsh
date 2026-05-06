# kubectl plugin architecture

End-to-end lifecycle of a `kubectl <command>` invocation when `hsh shell-init` is active.

## Pipeline

```
$ kubectl get pods -n production
       │
       ▼
[shell function] kubectl() → command hsh plugin run kubectl -- "$@"
       │
       ▼
[hsh plugin] src/plugins/kubectl.ts
   1. detectContext(args)                          → which Kubernetes context?
   2. listConnections(api)                         → fetch from Hoop API (3s timeout, fail-open)
   3. matchConnection(connections, context, "kubectl") → find Hoop connection (exact > schema-field > tag)
   4. getK8sCredentials(name)                      → reuse cached or POST /credentials
   5. writeEphemeralKubeconfig(name, creds)        → ~/.hsh/kube/<name>.yaml (mode 0600, atomic)
   6. spawn("kubectl", args, { env: { KUBECONFIG: <hsh-path>:<user-original> } })
       │
       ▼
[real kubectl process] sees the merged KUBECONFIG, picks the Hoop entry first,
                       executes the user's get/exec/apply/etc.
```

## State directories

| Path                          | Purpose                                    | Lifecycle                              |
|-------------------------------|--------------------------------------------|----------------------------------------|
| `~/.hsh/auth.json`            | OAuth JWT + expiry                         | `hsh login` writes; `hsh logout` clears |
| `~/.hsh/sessions/<conn>.json` | Cached Hoop credentials per connection     | Written by ENG-347 atomic write; cleared on expiry / `hsh logout` |
| `~/.hsh/kube/<conn>.yaml`     | Ephemeral kubeconfig per connection        | Same lifecycle as the session file (ENG-343) |
| `~/.kube/config`              | **User's real kubeconfig — never modified** | Untouched by hsh                      |

The last row is the headline contract: hsh never writes to `~/.kube/config`. Verified by [`tests/kubeconfig.integration.test.ts`](../../tests/kubeconfig.integration.test.ts), which captures the user's config bytes before a Hoop kubectl call and asserts they're bit-identical after.

## Multi-namespace, multi-cluster, multi-terminal

### Multi-namespace (`kubectl -n foo` ↔ `kubectl -n bar`)

The `-n`/`--namespace` flag is just an argv flag. It's not part of context detection (`detectContext()` only consults `--context`, `--kubeconfig`, `KUBECONFIG`, and `~/.kube/config`'s `current-context`). The flag flows through to the spawned `kubectl` unchanged. Both namespace calls hit the **same** Hoop credential cache and the **same** ephemeral kubeconfig — one credential issuance covers all namespaces.

Pinned by [`tests/multi-cluster.integration.test.ts`](../../tests/multi-cluster.integration.test.ts) (`Multi-namespace` section).

### Multi-cluster (`kubectl --context cluster-a` ↔ `kubectl --context cluster-b`)

Each context name produces:
- A different connection match (different `connection.name`).
- A different cached credential file (`~/.hsh/sessions/cluster-a.json` vs `cluster-b.json`).
- A different ephemeral kubeconfig (`~/.hsh/kube/cluster-a.yaml` vs `cluster-b.yaml`).

The two are **independent**. Switching mid-session is safe; clearing one doesn't affect the other; `hsh logout` wipes all of them.

Pinned by tests in `Multi-cluster` section.

### Multi-terminal (two shells, same context)

Two terminals issuing `kubectl get pods` against the same context simultaneously share the same connection name → the same cache file. Writes are atomic (write-temp → fsync → rename, see [ENG-347](https://linear.app/hoophq/issue/ENG-347)) so neither terminal can leave a torn JSON behind. The first terminal that misses the cache POSTs `/credentials`; the second terminal will either:

- See the cached file (race window: small but possible), or
- Also POST and overwrite atomically — since both POSTs are for the **same connection**, both responses are equivalent for the user's purposes.

There's no risk of either terminal seeing a half-written file or stale bytes from the previous response. Both end up with a valid kubeconfig and reach the gateway successfully.

Pinned by `Multi-terminal` section + the concurrent-writers test in `tests/safe-write.test.ts` (8 child Bun processes × 50 writes against a shared path → file always parses, no `.tmp` survivors).

## Failure modes

| What happens                              | Effect                                                           |
|-------------------------------------------|------------------------------------------------------------------|
| API unreachable (3s timeout)              | Warning to stderr → falls open to native `kubectl` ([ENG-353](https://linear.app/hoophq/issue/ENG-353)) |
| Context doesn't match any Hoop connection | Falls open to native `kubectl` ([ENG-351](https://linear.app/hoophq/issue/ENG-351))             |
| In-cluster (no kubeconfig anywhere)       | Falls open to native `kubectl` ([ENG-350](https://linear.app/hoophq/issue/ENG-350))             |
| Connection requires approval              | Exits 75 (EX_TEMPFAIL); user must approve in the Hoop UI ([ENG-348](https://linear.app/hoophq/issue/ENG-348)) |
| Credential cache file is corrupted        | File is unlinked, fresh credential issued ([sessions.ts](../../src/auth/sessions.ts)) |

In all of these, the user's `~/.kube/config` is untouched and the failure is communicated either via a one-line stderr warning or a non-zero exit code.

## Where to look in code

| File                                        | What                                              |
|---------------------------------------------|---------------------------------------------------|
| `src/plugins/kubectl.ts`                    | Pipeline orchestration                            |
| `src/plugins/kubectl-context.ts`            | Step 1: which context? (5-priority chain)         |
| `src/plugins/match.ts`                      | Step 3: which Hoop connection?                    |
| `src/auth/sessions.ts`                      | Step 4: credential cache (atomic writes, expiry)  |
| `src/plugins/kubeconfig.ts`                 | Step 5: ephemeral kubeconfig YAML rendering       |
| `src/util/safe-write.ts`                    | Atomic write helper used by 4 + 5                 |
| `src/api/client.ts`                         | Step 2: `fetchWithTimeout` + typed errors         |

## See also

- [`docs/connection-matching.md`](../connection-matching.md) — how `matchConnection` decides which Hoop connection to use.
- [`docs/troubleshooting.md`](../troubleshooting.md) — exit codes, debug mode, common diagnoses.
- [`docs/testing/passthrough.md`](../testing/passthrough.md) — passthrough fidelity scenarios (mostly ssh, but the kubectl plugin shares the philosophy).
