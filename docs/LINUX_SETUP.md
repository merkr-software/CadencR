# Linux development setup

This guide documents the setup path for running Cadencr from source on a native Ubuntu Linux machine.

## Environment

- Ubuntu Linux. The commands below were validated on Ubuntu 26.04 LTS.
- Node.js `22.19.0`; the repo enforces `>=22.19.0 <23.0.0`.
- pnpm through Corepack. The exact pnpm version is pinned by the root `package.json`.
- Rust through rustup.
- At least one local agent CLI you want to use: Claude Code, OpenCode, or Codex.

Run the commands below from a normal user shell. Use the repository root for project commands.

## System packages

Install the C/Rust build toolchain, OpenSSL headers, Git, ripgrep, and the Linux GUI libraries Electron needs:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential pkg-config libssl-dev curl ca-certificates git ripgrep \
  libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libcairo2 \
  libgtk-3-0t64 libpango-1.0-0 libxdamage1 libgbm1 libxkbcommon0 \
  libatspi2.0-0t64 libnss3 libxss1 libasound2t64 xdg-utils
```

If Electron fails to start with a missing shared library, check the remaining gaps with:

```bash
ldd node_modules/electron/dist/electron | grep 'not found'
```

Install the missing Ubuntu package, then retry `pnpm dev`.

## Node and pnpm

Install Node.js with nvm:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Restart your shell, then install the Node version pinned by the repo:

```bash
nvm install 22.19.0
nvm use
corepack enable
```

`nvm use` and `nvm install` read the version from `.nvmrc`. To switch
automatically whenever you `cd` into the repo, use nvm's
[shell integration](https://github.com/nvm-sh/nvm#deeper-shell-integration) or
[fnm](https://github.com/Schniz/fnm) with `fnm env --use-on-cd`.

Install workspace dependencies from the lockfile:

```bash
pnpm install --frozen-lockfile
```

`pnpm setup:dev` (below) installs the Electron binary.

## Rust

Install Rust with rustup if it is not already installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf -o /tmp/rustup-init https://sh.rustup.rs
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --profile minimal
. "$HOME/.cargo/env"
rustup toolchain install   # in the repo root: the toolchain, rustfmt and clippy from rust-toolchain.toml
cargo install --locked watchexec-cli
```

`pnpm dev` uses watchexec to restart the Rust service on changes; an existing
`cargo-watch` install also works as a fallback.

## Local environment files

From the repository root of the main checkout:

```bash
pnpm setup:dev --precompile
pnpm doctor
```

`pnpm setup:dev` creates `packages/service/.env` and `packages/desktop/.env`
from their examples when missing, writes one random token to both
`CADENCR_AUTH_TOKEN` and `VITE_API_TOKEN`, and installs the Electron binary;
`--precompile` also builds the Rust targets so the first `pnpm dev` is not a
cold Cargo build. `pnpm doctor` checks Node, pnpm, Rust, the watcher, both
`.env` files, and Electron, and prints a fix for each problem. In a linked Git
worktree, run `pnpm dev:configure-worktree` instead of `pnpm setup:dev`.

Keep the default ports unless they conflict with another local process:

- desktop renderer: `1420`
- Rust service: `5005`
- remote TLS listener: `5007`

## Electron sandbox permissions

On native Linux, Electron may abort with this error:

```text
The SUID sandbox helper binary was found, but is not configured correctly.
```

Fix the sandbox helper permissions after `pnpm install` has created `node_modules`:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Repeat this step if `node_modules` is deleted, Electron is reinstalled, or the Electron package is upgraded.

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

## Expected Linux warnings

Electron may print Mesa, DBus, dconf, or GPU warnings depending on the desktop session and GPU driver, for example:

```text
MESA-LOADER: failed to open dri
Failed to connect to the bus
failed to commit changes to dconf
```

These are usually non-blocking as long as the Electron window opens and the service logs:

```text
Cadencr service listening on 127.0.0.1:5005
```

The service may also warn that `claude` or `opencode` are not installed. That only means those provider CLIs are unavailable locally; any installed and configured provider CLI can still be used.

## Validation

After setup, these commands should pass:

```bash
pnpm doctor
pnpm --filter @cadencr/desktop ts-check
pnpm --filter @cadencr/service lint
```

Then run `pnpm dev` and confirm that the service, renderer, and Electron window start.
