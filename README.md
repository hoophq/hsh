<p align="center">
  <br />
  <strong><code>hsh</code></strong>
  <br />
  <em>Hoop Shell Plugins</em>
  <br />
  <br />
  Access your infrastructure through the tools you already use.
  <br />
  One line in your <code>.bashrc</code>. Zero workflow changes.
  <br />
  <br />
</p>

---

**hsh** is a shell plugin system that makes [Hoop](https://hoop.dev) invisible. It intercepts native CLI commands like `ssh` and `kubectl`, handles authentication, finds the right connection, and routes everything through the Hoop gateway — automatically.

No context switching. No web UI. No copy-pasting tokens between windows.

## How it works

```
You type:          ssh production-server
                        │
hsh intercepts:         ▼
                   ┌─────────┐
                   │   hsh   │──▶ Checks local JWT (valid? expired?)
                   │         │──▶ Finds "production-server" in Hoop API
                   │         │──▶ Creates a temporary session token
                   └────┬────┘
                        │
                        ▼
                   ╔═══════════════════════════════════╗
                   ║  Hoop SSH Access                  ║
                   ║                                   ║
                   ║  Connection: production-server     ║
                   ║  Token:      xssh-a8f3c...        ║
                   ║                                   ║
                   ║  Copy this token when prompted     ║
                   ╚═══════════════════════════════════╝
                        │
                        ▼
                   Connects to Hoop gateway via SSH
                   You paste the token → you're in.
```

For **Kubernetes**, it's even more seamless — hsh injects the proxy and token directly into your kubeconfig. `kubectl` just works.

## Quick start

### 1. Install

Download the binary for your platform from [Releases](https://github.com/hoophq/hsh/releases):

```bash
# macOS (Apple Silicon)
curl -L -o hsh https://github.com/hoophq/hsh/releases/latest/download/hsh-darwin-arm64
chmod +x hsh
sudo mv hsh /usr/local/bin/

# macOS (Intel)
curl -L -o hsh https://github.com/hoophq/hsh/releases/latest/download/hsh-darwin-x64
chmod +x hsh
sudo mv hsh /usr/local/bin/

# Linux (x64)
curl -L -o hsh https://github.com/hoophq/hsh/releases/latest/download/hsh-linux-x64
chmod +x hsh
sudo mv hsh /usr/local/bin/

# Linux (ARM64)
curl -L -o hsh https://github.com/hoophq/hsh/releases/latest/download/hsh-linux-arm64
chmod +x hsh
sudo mv hsh /usr/local/bin/
```

### 2. Configure

```bash
hsh config set api-url https://your-company.hoop.dev
```

### 3. Authenticate

```bash
hsh login
```

Opens your browser for OAuth. Done.

### 4. Activate shell plugins

Add this single line to your shell profile:

```bash
# bash / zsh
echo 'eval "$(hsh shell-init)"' >> ~/.bashrc    # or ~/.zshrc

# fish
echo 'hsh shell-init --shell fish | source' >> ~/.config/fish/config.fish
```

Restart your shell. That's it.

## Plugins

### SSH

The SSH plugin intercepts `ssh` commands, finds the matching Hoop connection, creates a temporary access token, and connects you through the Hoop gateway.

```bash
# Before hsh (the old way):
# 1. Open hoop.dev web UI
# 2. Find "production-db"
# 3. Click Connect → copy token
# 4. Open terminal → ssh gateway.hoop.dev
# 5. Paste token
# 😮‍💨

# With hsh:
ssh production-db
# ✓ That's it.
```

**What happens under the hood:**

1. Parses SSH arguments (`user@host`, `-p`, `-l`, etc.)
2. Checks your Hoop authentication (auto-login if needed)
3. Searches your Hoop connections for a match
4. Creates a session and generates a temporary token
5. Displays the token in a formatted box
6. Connects to the Hoop gateway via SSH

### Kubernetes

The kubectl plugin intercepts `kubectl` commands, detects your current context, finds the matching Hoop connection, and transparently configures the proxy.

```bash
# Before hsh:
# 1. Open hoop.dev web UI
# 2. Find the cluster connection
# 3. Run hoop connect
# 4. Copy proxy config
# 5. Update kubeconfig manually
# 🥲

# With hsh:
kubectl get pods
# ✓ Just works.
```

**What happens under the hood:**

1. Detects your kubectl context (current or `--context=X`)
2. Checks your Hoop authentication
3. Searches Hoop connections for a matching Kubernetes cluster
4. Creates a session and gets proxy credentials
5. Injects the Hoop proxy into your kubeconfig (with backup)
6. Runs `kubectl` transparently through the gateway

If no Hoop connection matches the context, `kubectl` runs normally — no interruption.

## Commands

| Command | Description |
|---|---|
| `hsh login` | Authenticate with Hoop (opens browser) |
| `hsh logout` | Clear local credentials |
| `hsh status` | Show auth status, API URL, active plugins |
| `hsh config set <key> <value>` | Set configuration (e.g., `api-url`) |
| `hsh config get <key>` | Get a configuration value |
| `hsh config list` | Show all configuration |
| `hsh shell-init` | Output shell integration code |
| `hsh plugin list` | List available plugins |
| `hsh plugin run <name> -- <args>` | Run a plugin directly |

## How shell integration works

When you run `eval "$(hsh shell-init)"`, it creates shell functions that wrap native commands:

```bash
# What gets injected into your shell:
__hsh_ssh() {
  command hsh plugin run ssh -- "$@"
  return $?
}
alias ssh='__hsh_ssh'

__hsh_kubectl() {
  command hsh plugin run kubectl -- "$@"
  return $?
}
alias kubectl='__hsh_kubectl'
```

Your original `ssh` and `kubectl` binaries are untouched. The shell functions intercept the call, add the Hoop magic, and delegate to the gateway. If `hsh` is ever removed, your shell falls back to the native commands.

## Configuration

All configuration lives in `~/.hsh/`:

| File | Purpose |
|---|---|
| `~/.hsh/config.json` | API URL and settings |
| `~/.hsh/auth.json` | JWT token (permissions: `600`) |

## Building from source

Requires [Bun](https://bun.sh) v1.3+.

```bash
# Install dependencies
bun install

# Run in development
bun run src/index.ts --help

# Build for current platform
bun build --compile src/index.ts --outfile hsh

# Build for all platforms
bun run build
```

### Cross-platform binaries

The build script generates standalone binaries for all platforms:

```
dist/
├── hsh-linux-x64
├── hsh-linux-arm64
├── hsh-darwin-x64
├── hsh-darwin-arm64
└── hsh-windows-x64.exe
```

No runtime dependencies. Single binary. Copy and run.

## Architecture

```
src/
├── index.ts              CLI entry point
├── commands/
│   ├── login.ts          OAuth browser login
│   ├── logout.ts         Clear credentials
│   ├── status.ts         Auth & config status
│   ├── config.ts         Configuration management
│   ├── shell-init.ts     Shell integration generator
│   └── plugin.ts         Plugin runner
├── plugins/
│   ├── base.ts           Plugin interface
│   ├── registry.ts       Plugin registration
│   ├── ssh.ts            SSH plugin
│   └── kubectl.ts        Kubernetes plugin
├── api/
│   ├── client.ts         Hoop API client
│   └── types.ts          API types
├── auth/
│   ├── manager.ts        Auth orchestration
│   ├── oauth.ts          OAuth browser flow
│   └── store.ts          Token persistence
├── config/
│   └── store.ts          Config file management
└── ui/
    └── output.ts         Terminal formatting
```

## Troubleshooting

When something doesn't behave the way you expect — `hsh` falls through to native ssh/kubectl when you wanted it to route through Hoop, or vice versa, or the wrong connection gets picked — set the `HSH_DEBUG` environment variable to see exactly what `hsh` decided.

```bash
HSH_DEBUG=1 ssh production-db 2>debug.log
HSH_DEBUG=1 kubectl get pods 2>debug.log
```

Output goes to **stderr only**, so it never pollutes the program's stdout. Format is grep-friendly:

```
[hsh debug] ssh: argv parsed {"argc":1,"host":"production-db","user":null,"port":null}
[hsh debug] api: fetch GET https://api.hoop.dev/api/connections timeoutMs=3000
[hsh debug] api: response 200 https://api.hoop.dev/api/connections
[hsh debug] match: ssh {"target":"production-db","level":"exact","winner":"production-db","candidates":["production-db"],"ambiguous":false}
[hsh debug] cache: ssh miss name=production-db
[hsh debug] api: fetch POST https://api.hoop.dev/api/connections/production-db/credentials timeoutMs=3000
[hsh debug] api: response 200 ...
```

`HSH_DEBUG` accepts `1`, `true`, `yes`, or `on` (case-insensitive). Anything else (including unset) keeps the logger silent — there is no runtime cost when the flag is off.

**Security**: tokens, passwords, and refresh tokens are never written through this logger by design. The codebase has a regression test (`tests/log.test.ts`) that fails CI if a `debug(...)` call ever passes a credential.

Common things to check from the debug output:

* **`match: level=null`** — your target didn't match any Hoop connection at any priority level (exact, schema-field, tag). See [`docs/connection-matching.md`](docs/connection-matching.md) for the rules.
* **`api: fetch failed reason=timeout`** — gateway is unreachable. `hsh` falls open to native ssh/kubectl after ~3s. Run `hsh status` to confirm the API URL.
* **`cache: hit expire_at=…`** — `hsh` reused a cached credential. To force a fresh issue, run `hsh logout` (clears every cache file) or wait for the listed expiry.

## License

MIT
