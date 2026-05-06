# Troubleshooting hsh

For debugging which path your invocation took (Hoop-routed vs passthrough), see [`HSH_DEBUG=1`](#debug-mode) below. For why `hsh` may not have matched a connection, see [`docs/connection-matching.md`](connection-matching.md). For passthrough fidelity, see [`docs/testing/passthrough.md`](testing/passthrough.md).

## Exit codes

`hsh`'s exit code is what your shell sees in `$?` after `ssh`/`kubectl` returns. Scripts wrapping these commands depend on the code being meaningful.

| `$?`    | Source                | Meaning                                                                                          |
|---------|-----------------------|--------------------------------------------------------------------------------------------------|
| `0`     | child or hsh          | Clean success — passthrough succeeded, OR the Hoop-routed `ssh`/`kubectl` child exited 0.        |
| `1–127` | child (verbatim)      | The underlying `ssh` or `kubectl` returned this code. `hsh` passes it through unchanged. Common values: `1` generic, `124` GNU-coreutils-style timeout, `127` command-not-found, `130` Ctrl-C (`SIGINT`), `255` ssh protocol error / disconnect. |
| `1`     | hsh                   | Generic hsh-internal error before the child could be spawned (malformed credential response, unexpected throw). Collides with ssh's generic-1; check stderr for an `✗`-prefixed line to disambiguate. |
| `75`    | hsh                   | `EX_TEMPFAIL` (sysexits.h §75). The Hoop connection requires approval and credentials weren't issued yet — go approve in the Hoop UI and retry. **Distinct from `0` so scripts don't mistake \"waiting on review\" for success.** |

The mapping is locked down by [`tests/exit-codes.test.ts`](../tests/exit-codes.test.ts), which spawns a fake `ssh`/`kubectl` shim under a temp PATH and asserts the parent process exits with the same code for every form above. The same file has a static audit that fails CI if anyone reintroduces a bare `process.exit(0)` or `process.exit(1)` in `src/plugins/*.ts` instead of using the `ExitCodes` constants.

### Why we don't invent more codes

Inventing more codes (e.g. `78` for \"API unreachable\") would fragment the script-callability contract for marginal value. The current behavior on API-unreachable is **passthrough** ([ENG-353](https://linear.app/hoophq/issue/ENG-353)), so the code your script sees is whatever the underlying `ssh`/`kubectl` returned — usually meaningful (network-related ssh exits 255). If a future ticket changes that policy and \"API unreachable\" needs its own code, `EX_UNAVAILABLE` (69) is the canonical pick.

## Common questions

### \"hsh ran the wrong connection\"

```bash
HSH_DEBUG=1 ssh production-db 2>debug.log
```

Look for the `[hsh debug] match: ssh` line. If `level=null` your target didn't match any rule — see [`docs/connection-matching.md`](connection-matching.md).

If `ambiguous=true`, the warning lists every candidate. Pick a connection name unique enough to win at the `exact` level, or add a more specific `tags.host` (ssh) / `tags.context` (kubectl) on the connection.

### \"hsh hangs forever when the API is down\"

It shouldn't. The fetch timeout is 3s ([ENG-353](https://linear.app/hoophq/issue/ENG-353)), then `hsh` falls open to native ssh/kubectl with a one-line warning. If you're seeing >5s hangs, run `HSH_DEBUG=1` and check for `[hsh debug] api: fetch ...` lines — they should show `timeoutMs=3000`.

### \"My script broke after upgrading hsh\"

If your script depended on hsh exiting 0 when a connection requires approval (the old behavior), update it to handle exit code 75 as \"try again later\". The change shipped in [ENG-348](https://linear.app/hoophq/issue/ENG-348) — `process.exit(0)` was a bug, since the user's `ssh host` command failed to establish a connection.

## Debug mode

```bash
HSH_DEBUG=1 ssh host 2>debug.log
HSH_DEBUG=1 kubectl get pods 2>debug.log
```

Output goes to **stderr only**. Format is grep-friendly: `[hsh debug] component: message [extras]`. See the full description in the project README's Troubleshooting section.

`HSH_DEBUG` accepts `1`, `true`, `yes`, or `on` (case-insensitive). Anything else (including unset) keeps the logger silent — there's no runtime cost when off.

**Tokens, passwords, and refresh tokens are never written through this logger by design.** A static test (`tests/log.test.ts`) walks every `debug(` call site in `src/` and fails CI if a credential is ever passed.
