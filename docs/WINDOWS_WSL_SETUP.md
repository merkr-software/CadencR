# Windows / WSL development setup

This guide documents the setup path for running Cadencr from source on Windows through WSL2 and WSLg.

## Environment

- Windows with WSL2 enabled.
- Ubuntu in WSL.
- WSLg enabled so Electron can open a Linux GUI window.
- Node.js `22.18.0`; the repo enforces `>=22.18.0 <23.0.0`.

The commands below should be run inside the WSL shell from the repository root.

## System packages

Install the C/Rust build toolchain and the Linux GUI libraries Electron needs:

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config
sudo apt-get install -y libatk1.0-0 libatk-bridge2.0-0 libcups2 libcairo2 libgtk-3-0 libpango-1.0-0 libxdamage1 libgbm1 libxkbcommon0 libatspi2.0-0
```

If Electron still fails to start with a missing shared library, check the remaining gaps with:

```bash
ldd node_modules/electron/dist/electron | grep 'not found'
```

Install the missing Ubuntu package, then retry `pnpm dev`.

## Node and pnpm

Enable Corepack and install workspace dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @cadencr/desktop ensure:electron
```

The project pins pnpm through `packageManager` in the root `package.json`.

## Rust

Install Rust with rustup if it is not already installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf -o /tmp/rustup-init https://sh.rustup.rs
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --profile minimal
. "$HOME/.cargo/env"
rustup component add rustfmt clippy
cargo install cargo-watch --locked
```

Optional, but useful for warming the cache before the first dev launch:

```bash
cargo fetch
cargo check
```

## Local environment files

Create local env files from the examples:

```bash
cp packages/service/.env.example packages/service/.env
cp packages/desktop/.env.example packages/desktop/.env
```

Set the same random local token in both files:

- `CADENCR_AUTH_TOKEN` in `packages/service/.env`
- `VITE_API_TOKEN` in `packages/desktop/.env`

Keep the default ports unless they conflict with another local process:

- desktop renderer: `1420`
- Rust service: `5005`
- remote TLS listener: `5007`

## Start the app

Use the normal full-workspace dev command:

```bash
pnpm dev
```

Expected local services:

- Electron renderer: `http://127.0.0.1:1420/`
- Rust service: `http://127.0.0.1:5005/`
- Landing site: `http://localhost:4321/`

For desktop-only development, use:

```bash
pnpm start
```

## Expected WSL warnings

Electron may print DBus, dconf, or GPU warnings under WSLg, for example:

```text
Failed to connect to the bus
failed to commit changes to dconf
GLES3 is unsupported
```

These are usually WSLg noise as long as the Electron window opens and the service logs:

```text
Cadencr service listening on 127.0.0.1:5005
```

The service may also warn that `claude` or `opencode` are not installed. That only means those provider CLIs are unavailable locally; Codex can still work if its CLI is installed and configured.
