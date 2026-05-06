# Shell compatibility

`hsh shell-init` emits POSIX-shell or fish-shell code that defines the `ssh` and `kubectl` shell functions plus `GIT_SSH_COMMAND`/`RSYNC_RSH` env vars. The generated code is **shell-language-sensitive**: a stray space, a missing `command` builtin, or the wrong quoting style can produce silently broken behavior (commands that recurse infinitely, exit codes that get swallowed, env vars that aren't exported).

This document captures the support matrix and the test layers that lock it down.

## Support matrix

| Shell  | Status | Notes                                                                     |
|--------|--------|---------------------------------------------------------------------------|
| bash   | ✓ supported | Linux 5.x and macOS 3.2 (apple's bundled bash). POSIX-variant of shell-init. |
| zsh    | ✓ supported | macOS default; widely used on Linux. POSIX-variant of shell-init.        |
| dash   | ✓ supported | Linux's `/bin/sh` on Debian/Ubuntu. POSIX-variant of shell-init.          |
| sh     | ✓ supported | macOS's `/bin/sh` (bash 3.2 in POSIX mode). POSIX-variant of shell-init.   |
| fish   | ✓ supported | Distinct fish-variant of shell-init (`hsh shell-init --shell fish \| source`). |
| nushell| ✗ not supported | Different language. PRs welcome but not on the roadmap. |
| xonsh  | ✗ not supported | Python-based. PRs welcome but not on the roadmap. |
| powershell | ✗ not supported | Different language; Windows users can use `hsh.exe` directly with the `kubeconfig` workflow ([docs/compatibility.md](../compatibility.md)). |

## What we test

There are three layers, in increasing fidelity:

### 1. Bytes of the rendered script (unit tests)

[`tests/shell-init.test.ts`](../../tests/shell-init.test.ts) — pins the exact text emitted by `generatePosix` and `generateFish`:

- Function definitions per command (`ssh()` / `function ssh`).
- Use of the `command` builtin to avoid the function recursing into itself.
- `return $?` (POSIX) / explicit fish equivalent for exit-code propagation.
- `GIT_SSH_COMMAND` and `RSYNC_RSH` exports.
- Header comments with the install hint.
- Edge cases: empty plugin list still produces sourceable code; function name comes from `command`, not `plugin`.

These run in CI on every PR; they're the first line of defense against unintentional formatting drift.

### 2. Real-shell behavior (integration tests)

[`tests/shell-integration.test.ts`](../../tests/shell-integration.test.ts) drives [`tests/shell/scenarios.sh`](../../tests/shell/scenarios.sh) and [`tests/shell/scenarios.fish`](../../tests/shell/scenarios.fish) under each shell available on the runner. The tests source the real `hsh shell-init` output, then exercise:

| Scenario                       | What it checks                                                                                   |
|--------------------------------|--------------------------------------------------------------------------------------------------|
| `defines_ssh_function`         | `ssh foo` actually routes through the function (not the system `ssh`).                          |
| `defines_kubectl_function`     | Same, for `kubectl`.                                                                            |
| `function_routes_through_hsh`  | Argv reaches `hsh plugin run ssh -- ...` byte-for-byte.                                          |
| `command_bypass_skips_hsh`     | `command ssh ...` and absolute-path lookups bypass the function (per shell-builtin contract).   |
| `exit_code_propagates`         | `$?` after the function call equals the underlying child's exit code.                            |
| `exit_code_in_conditionals`    | `&&`, `\|\|`, and `if` chains see the function's exit code correctly. (We don't lock down `set -e` because POSIX has subtle exemptions that vary by shell.) |
| `subshell_inherits_function`   | `( ssh foo )` works — POSIX guarantees function inheritance into `()` subshells.                |
| `pipe_works`                   | `ssh foo \| cat` doesn't break; the function plays nicely with pipelines.                        |
| `git_ssh_command_export`       | `GIT_SSH_COMMAND` is exported, ready for `git push` over ssh.                                    |
| `rsync_rsh_export`             | `RSYNC_RSH` is exported.                                                                          |

The harness installs a fake `hsh` shim that records its argv. We then invoke `ssh foo` and assert the shim received `argv: plugin run ssh -- foo`. This proves the function definition is correct without needing real Hoop credentials.

### 3. Compiled-binary smoke (release-time only)

`hsh shell-init` is rendered by the same code path whether you run it via `bun src/index.ts` or via the compiled binary `hsh`. CI doesn't compile the binary on every PR (it's slow); the integration tests above use a `bun run`-wrapping shim that exercises the same rendering code.

The release process should still smoke-test `eval "$(./hsh shell-init)"; ssh foo` on each supported platform's compiled binary before publishing.

## CI matrix

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs the full test suite (including the shell-integration scenarios) on:

- `ubuntu-latest` — bash, zsh, dash, fish (zsh + fish + dash installed by the workflow; bash + sh come pre-installed)
- `macos-latest` — bash 3.2, zsh, sh (fish installed via brew; bash + zsh + sh come pre-installed)

Skipped shells in the test runner emit a `describe.skip` block so the report is honest about what was tested. If you add a new shell to the integration tests, add the corresponding install step in the workflow.

## What the tests intentionally don't cover

- **`set -e` propagation**: POSIX has multiple exemptions for `set -e` (commands in conditional contexts, the last command of a function, etc.) that vary subtly between bash, zsh, and dash. We assert what scripts actually depend on (`$?`, `&&`, `\|\|`, `if`) and stay out of `set -e`'s minefield.
- **Interactive features**: tab completion, history, prompt integration. These are out of scope for shell-init.
- **Login vs interactive**: the function works in both; we don't have a separate test layer.
- **shell startup files**: the install hint is `eval "$(hsh shell-init)"` in `~/.bashrc`/`~/.zshrc`/`config.fish`. Sourcing in the right startup file is the user's responsibility.

## Adding a new scenario

1. Add the case in `tests/shell/scenarios.sh` (and `.fish` if the behavior differs in fish).
2. Add the scenario name to the `POSIX_SCENARIOS` (or `FISH_SCENARIOS`) array in `tests/shell-integration.test.ts`.
3. Run `bun test tests/shell-integration.test.ts` locally — the runner discovers shells available on PATH.
4. The CI matrix picks it up automatically.

## Adding support for a new shell

1. Decide if it's POSIX-compatible enough to share `scenarios.sh`. If not, write a `scenarios.<shell>.<ext>` analogue.
2. Add the shell to `discoverShells()` in `tests/shell-integration.test.ts`.
3. Add an install step in `.github/workflows/ci.yml`.
4. Update the support matrix at the top of this doc.
5. Update the corresponding generator in `src/commands/shell-init.ts` if a new variant is needed.
