<p align="center">
  <img src="packages/landing/src/assets/hero.png" alt="Cadencr desktop workspace with agent stream, editor, terminal, and Git review" width="920" />
</p>

<h1 align="center">Cadencr</h1>

<p align="center">
  <strong>The IDE for the era of agents.</strong><br />
  One workspace to read, steer, and ship with Claude Code, OpenCode, and Codex.
</p>

<p align="center">
  <a href="https://cadencr.com">Website</a>
  ·
  <a href="https://cadencr.com/docs/">Docs</a>
  ·
  <a href="https://github.com/merkr-software/CadencR/releases">Download</a>
</p>

---

## Stop babysitting agents in a terminal scrollback

CLI coding agents are powerful, but the workflow around them is still too often a pile of terminals, branches, diffs, and half-remembered context.

Cadencr turns local coding agents into a desktop IDE experience: every task gets a focused workspace with its own agent session, Git worktree, editor, terminal, approvals, and review flow.

You keep the agents you already use. Cadencr gives you the surface to supervise them without losing the thread.

## What you get

| Instead of... | Cadencr gives you... |
| --- | --- |
| One terminal per agent | A unified cockpit for Claude Code, OpenCode, and Codex sessions. |
| Agents fighting in the same checkout | Isolated feature workspaces backed by Git worktrees. |
| Endless tool-call scrollback | Rendered streams with grouped tools, readable outputs, approvals, and file changes. |
| Jumping between editor, terminal, and Git UI | Files, diffs, terminal, commits, and sessions in one place. |
| Guessing what changed | A review-first flow built around diffs, files, and human checkpoints. |

## Built for real agent workflows

### Run agents in parallel

Start several features, fixes, or investigations at once. Each session works in its own branch and worktree, so one agent can run tests while another explores a bug or prepares a refactor.

### Read what happened

Cadencr turns raw agent output into something scannable: tool calls collapse, file writes are visible, long outputs stay out of the way, and approvals become explicit checkpoints.

### Review before you ship

Open touched files, compare diffs, use the terminal, stage changes, and prepare commits without leaving the task context. The agent can move fast; you stay in control.

### Bring your own agent

Cadencr is provider-neutral by design. Claude Code, OpenCode, and Codex are surfaced through shared workflows instead of hardcoded product assumptions.

## Install

### macOS

Download the latest build from [GitHub Releases](https://github.com/merkr-software/CadencR/releases).

> Cadencr is early `0.x` software. Expect fast iteration, frequent updates, and a few sharp edges.

### Run from source

Use this path if you want to try the latest code or contribute.

On Linux, follow the [Linux development setup](./docs/LINUX_SETUP.md).

#### Requirements

- **Node.js 22.x** — the repo enforces `>=22.18.0 <23.0.0`.
- **pnpm** — managed through Corepack.
- **Rust** — install with [rustup](https://rustup.rs/).
- **cargo-watch** — required by `pnpm dev` for the Rust service watcher. Install with `cargo install cargo-watch`.
- At least one local agent CLI you want to use: Claude Code, OpenCode, or Codex.

#### Setup

```bash
git clone https://github.com/merkr-software/CadencR.git
cd CadencR

corepack enable
pnpm install

cp packages/service/.env.example packages/service/.env
cp packages/desktop/.env.example packages/desktop/.env
```

Set the same local token in both env files:

- `CADENCR_AUTH_TOKEN` in `packages/service/.env`
- `VITE_API_TOKEN` in `packages/desktop/.env`

Then start the app:

```bash
pnpm dev
```

## Development

```bash
pnpm build                              # build the desktop app
pnpm test                               # Vitest + Rust tests
pnpm lint                               # oxlint
pnpm format                             # oxfmt + cargo fmt
pnpm --filter @cadencr/desktop ts-check # TypeScript checks
pnpm --filter @cadencr/desktop knip     # unused export detection
```

## How it works

```text
packages/
├── desktop/                 # Electron shell + React frontend
├── service/                 # Rust API/WebSocket service, packaged as sidecar
├── claude-agent-sdk-rs/     # Claude Code transport SDK
├── codex-app-server-sdk-rs/ # Codex transport SDK
├── opencode-sdk-rs/         # OpenCode transport SDK
├── cli-discovery/           # Local agent CLI discovery
└── landing/                 # Marketing site, docs, news, roadmap
```

- **Desktop ↔ Service** — HTTP for requests and WebSocket for live updates.
- **Service ↔ Agents** — provider adapters call local CLIs through focused Rust SDKs.
- **Work isolation** — sessions run in Git worktrees so parallel work stays separated.
- **Release flow** — tagged desktop releases build, sign, notarize, and publish macOS artifacts from GitHub Actions.

## Open an issue or contribute

- Found a bug or have a feature idea? [Open an issue](https://github.com/merkr-software/CadencR/issues/new/choose).
- Want to contribute? Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Please follow the [Code of Conduct](./.github/CODE_OF_CONDUCT.md).
- Security reports should use [GitHub private vulnerability reporting](https://github.com/merkr-software/CadencR/security/advisories/new).
