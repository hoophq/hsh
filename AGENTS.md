# AGENTS.md — hsh (Hoop Shell Plugins CLI)

## Naming
- Product is **Hoop**, binary is `hsh`, API is `hoop.dev`. Never say "Rupi".
- CLI is built with Commander.js; all commands are added in `src/index.ts`.

## Commands
| Task | Command |
|---|---|
| dev (run from source) | `bun run dev` (or `bun run src/index.ts -- …`) |
| typecheck | `bun run typecheck` (alias: `tsc --noEmit`) |
| test (all) | `bun test` |
| test (single file) | `bun test tests/<name>.test.ts` |
| test (watch) | `bun test --watch` |
| build (all targets) | `bun run build` (creates `dist/` with 5 platform binaries) |
| build (local only) | `bun build --compile src/index.ts --outfile hsh` |
| lint | _None configured. TypeScript strict mode is enforced by `tsconfig.json`._ |

**Order**: typecheck → test. There's no separate lint step.

## Key architecture decisions
- **Shell plugin system**: `eval "$(hsh shell-init)"` injects shell functions that intercept `ssh`/`kubectl` and route through Hoop gateway. Plugins are in `src/plugins/`.
- **State dir**: `~/.hsh/` by default. Override with `HSH_HOME` env var (used extensively in tests for hermetic runs). Config is `config.json`, auth is `auth.json`.
- **Connection matching**: strict leveled matching in `src/plugins/match.ts` (exact → exact-short → schema-field → tag). No dangerous substring fallback.
- **Debug logging**: gated on `HSH_DEBUG=1` (or `true`/`yes`/`on`). Outputs to stderr only. **Never** pass tokens/passwords/refresh tokens to `debug()`. CI regression test lives in `tests/log.test.ts`.

## Exit codes (src/plugins/exit-codes.ts)
| Constant | Value | Meaning |
|---|---|---|
| `Success` | 0 | Clean passthrough or Hoop child exited 0 |
| `GenericError` | 1 | hsh failure before child spawned |
| `ReviewPending` | 75 | Connection requires approval (EX_TEMPFAIL) |
| `AuthRequired` | 77 | Session expired, user must run `hsh login` (EX_NOPERM) |

Every `process.exit()` in `src/plugins/ssh.ts`, `src/plugins/kubectl.ts`, and `src/commands/kubeconfig.ts` must use these constants — a CI audit (`tests/exit-codes.test.ts`) catches bare numeric literals.

## Testing
- **Framework**: Bun's built-in test runner. Import from `"bun:test"`.
- **Shell integration tests** (`tests/shell-integration.test.ts`): discover available shells on PATH (bash, zsh, dash, fish) and run scenario scripts from `tests/shell/` against a temporary `hsh` shim.
- **Hermetic state**: tests set `HSH_HOME` to a temp dir so they don't touch real `~/.hsh`.
- **CI requires kubectl**: installed via `azure/setup-kubectl@v4` in CI. Local shell-integration tests need `kubectl` on PATH.
- **Sentinel test**: `tests/sentinel.test.ts` proves the runner is wired up.

## Release flow
1. Push a `v*` tag (e.g. `v0.2.0`). Do NOT bump `package.json`/`src/version.ts` manually — the release workflow does it.
2. CI bumps version in both files, commits with `[skip ci]`, force-moves the tag to the bump commit.
3. `bun run build` cross-compiles 5 platform binaries (`dist/hsh-linux-x64`, `hsh-linux-arm64`, `hsh-darwin-x64`, `hsh-darwin-arm64`, `hsh-windows-x64.exe`).
4. GitHub Release is created with binaries + SHA256SUMS.

## Version
- `src/version.ts` exports `VERSION` — single source of truth, used by `hsh --version`, `hsh status`, and update checker. Semver without leading `v`.

## Project layout (non-obvious)
- `src/plugins/` — shell plugins (ssh, kubectl), matching logic, exit codes, kubeconfig injection.
- `src/commands/` — CLI subcommands. Each file creates and exports a `Command`.
- `src/api/` — Hoop API client, request types, server info.
- `src/auth/` — OAuth flow, local auth, session management, askpass.
- `src/update/` — self-update checker and installer.
- `src/ui/` — chalk-based log formatting and boxen output.
- `src/util/safe-write.ts` — atomic JSON writes (config edits from concurrent shells must not corrupt).
- `src/config/store.ts` — config file CRUD; honors `HSH_HOME`.
- `tests/shell/` — reusable scenario scripts for shell integration tests.

## Nix (flake.nix)
- **Install**: `nix profile install github:hoophq/hsh` or `nix run github:hoophq/hsh -- ...`
- **Dev shell**: `nix develop` (provides bun, bun2nix, kubectl)
- **Dependency lock**: `bun.nix` is auto-generated from `bun.lock` via `nix run github:nix-community/bun2nix`. Re-run after `bun install` changes deps. The release workflow regenerates `bun.nix` and `flake.lock` automatically on every tag push.
- **Build**: uses `bun2nix` overlay → `fetchBunDeps` (fixed-output, fetches npm packages) → `bun build --compile` (sandboxed). No network access needed during the final build phase.

## Docs
- `docs/connection-matching.md` — matching rules.
- `docs/architecture/kubectl.md` — kubectl plugin design.
- `docs/decisions/ssh-token-injection.md` — SSH token injection decision record.
- `docs/testing/` — testing strategy docs for passthrough and shell compatibility.
