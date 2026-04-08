# Project: hsh - Hoop Shell Plugins CLI

## Important
- The product name is **Hoop**, not "Rupi". "Rupi" does not exist. Always use "Hoop" in code, messages, documentation, and conversations.
- The binary/CLI is called `hsh`.
- The API is the Hoop API (hoop.dev).

## Tech Stack
- TypeScript + Bun (binary compilation via `bun build --compile`)
- Commander.js, chalk, ora, boxen
- Shell plugin system inspired by 1Password CLI

## Architecture
- Shell integration: `eval "$(hsh shell-init)"` in .bashrc/.zshrc
- Plugins intercept native commands (ssh, kubectl) and route through Hoop gateway
- Auth: OAuth browser flow, JWT stored in ~/.hsh/auth.json
- Config: ~/.hsh/config.json (api-url is user-configurable)
