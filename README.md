<p align="center">
  <a href="https://cadencr.com">
    <img src="packages/landing/src/assets/hero.gif" alt="CadencR desktop workspace in action: streaming agent output, the project list, an inline diff, editor, terminal, embedded browser, and Git review" width="920" />
  </a>
</p>

<p align="center">
  <a href="https://cadencr.com"><strong>▶ Watch the full demo at cadencr.com</strong></a>
</p>

<h1 align="center">CadencR</h1>

<p align="center">
  <strong>Stop switching. One window for Agent, Git, Browser, Editor &amp; Terminal.</strong><br />
  The IDE for the era of agents: read, steer, and ship with Claude Code, OpenCode, and Codex.
</p>

<p align="center">
  <a href="https://cadencr.com">Website</a>
  ·
  <a href="https://cadencr.com/docs/">Docs</a>
  ·
  <a href="https://cadencr.com/news/">News</a>
  ·
  <a href="https://github.com/merkr-software/CadencR/releases">Download</a>
</p>

<p align="center">
  <sub>Open source · No telemetry · Apache 2.0 · macOS</sub>
</p>

---

## Stop babysitting agents in a terminal scrollback

CLI coding agents are powerful, but the workflow around them is still too often a pile of terminals, branches, diffs, and half-remembered context, with you alt-tabbing between windows all day.

CadencR turns local coding agents into a desktop IDE experience: every task gets a focused workspace with its own agent session, Git worktree, editor, terminal, embedded browser, approvals, and review flow.

You keep the agents you already use. CadencR gives you the surface to supervise them (every running agent, every project, every tab in one place) without losing the thread.

## What you get

| Instead of... | CadencR gives you... |
| --- | --- |
| One terminal per agent | A unified cockpit for Claude Code, OpenCode, and Codex sessions across every project. |
| Agents fighting in the same checkout | Isolated feature workspaces, each backed by its own Git worktree and branch. |
| Endless tool-call scrollback | Rendered streams with grouped tool-call pills, inline diffs, model tags, and a context meter. |
| Jumping between editor, terminal, and a Git UI | Files, diffs, terminal, an embedded browser, and commits in one place. |
| A separate window to check the app | A real Chromium pane your agent can drive to QA its own change. |
| Guessing what changed | A review-first flow built around diffs, commit previews, and human checkpoints. |

## Features

| Feature | What you get |
| --- | --- |
| **Agent** | Readable, steerable agent sessions. Raw output is rendered as collapsible tool-call pills (Bash, Grep, Read, Edit, Thinking), inline `+/-` diffs, per-message model tags, and a context meter. Plus plan approvals, tool-permission cards, and multiple-choice questions as keyboard checkpoints, in-conversation search (`⌘F`), and scheduled prompts. |
| **Orchestrate (Project & Workspace MCP)** | Loop-engineering built in: CadencR's own MCP servers let an agent inspect activity, list projects, compare session history, and **message or spawn sibling sessions** in the current project (Project MCP), and search conversation history across every project (Workspace MCP). Agents that coordinate agents. |
| **Browser (with Browser MCP)** | A real embedded Chromium pane with per-feature tabs, normal/private cookie modes, and page comments you send to the agent. Over the `cadencr-browser` MCP the agent opens pages, clicks, fills, screenshots, waits for selectors, and reads the console and failed network requests: agent-driven QA before it says "done". |
| **Git tab** | Review changed files (uncommitted or vs. the target branch) with themed diffs, commit previews before anything lands, and a **commit graph** across sessions × branches with links to the online commit. Commit (`⌘⇧K`), push (`⌘⇧U`), or open a compare/PR (`⌘⇧O`) from the header. |
| **Editor tab** | A real CodeMirror editor, not a viewer: LSP go-to-definition, references, symbols, diagnostics, and rename; file and content search, split panes and tabs, Git-gutter markers, blame, Markdown preview, multi-cursor, and a read-only large-file mode. Prefer modal editing? Switch to a real Neovim instance per session from Settings. |
| **Sidebar** | One rail for every project and feature. A global **Pinned** section above the project list keeps hot sessions reachable across projects, activity indicators flag busy features, ordering stays stable, and archived features remain searchable. |
| **Unified agent list** | Every session at once in a live grid. Filter by name, task, or feature, adjust row density, pin (`⌘⇧P`), and keyboard-navigate, with live status rings so you can read, steer, and review many agents without switching tabs. |

## Built for how agents actually work

- **Run agents in parallel.** Start several features, fixes, or investigations at once. Each session works on its own branch in its own Git worktree, so one agent can run tests while another explores a bug or prepares a refactor, with no fighting over the same checkout.
- **A real terminal, next to the agent.** One PTY per session, rooted at that session's worktree, for the things the agent shouldn't do: ssh, dev servers, ad-hoc scripts. Split the pane freely; a warning flags if the shell drifts out of the worktree. Rendered with [celeritty](https://github.com/edjubert/celeritty), a WebGPU terminal that reads your `alacritty.toml` for font and colors.
- **Approvals & permissions.** Plan approvals, tool-permission cards showing the exact command, and multi-choice questions become explicit keyboard checkpoints. Per-provider permission modes (from ask-every-time to auto-accept edits to opt-in bypass/full-access) cycle with `Shift+Tab`.
- **Custom actions.** Attach reusable shell commands to a project (lint, deploy, seed a database) with `${VARIABLE}` placeholders. Run them on demand from the `+` menu or on a fixed schedule against any feature's worktree.
- **Steer from a second screen.** Pair a phone, tablet, or second computer by QR code or link and drive the same sessions, terminals, and editor from a browser. Local-first (agents and state stay on your machine), works over your LAN or Tailscale, installs as a PWA, and can send Web Push notifications.
- **Works with the agents you run.** CadencR supports Claude Code, OpenCode, and Codex, surfacing each through the same shared workflows instead of hardcoded, per-provider assumptions, so switching between them doesn't mean relearning the app.

## Install

### macOS

CadencR currently ships a desktop build for **macOS on both Apple Silicon and Intel**. Native Linux and Windows builds are planned next; you can [run from source](#run-from-source) on either today.

Install with [Homebrew](https://brew.sh):

```bash
brew install --cask merkr-software/cadencr/cadencr
```

Or download the latest DMG/ZIP from [GitHub Releases](https://github.com/merkr-software/CadencR/releases).

> CadencR is early `0.x` software. Expect fast iteration, frequent updates, and a few sharp edges.

### Run from source

Use this path if you want to try the latest code or contribute.

On Linux, follow the [Linux development setup](./docs/LINUX_SETUP.md).

On Windows, use WSL2/WSLg and follow the [Windows / WSL development setup](./docs/WINDOWS_WSL_SETUP.md).

#### Requirements

- **Node.js 22.x**: the repo enforces `>=22.19.0 <23.0.0`.
- **pnpm**: managed through Corepack.
- **Rust**: install with [rustup](https://rustup.rs/).
- **cargo-watch**: required by `pnpm dev` for the Rust service watcher. Install with `cargo install cargo-watch`.
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

If you create Git worktrees through an automated setup hook, add
`pnpm dev:precompile` after `pnpm install`. It builds the Rust targets used by
`pnpm dev` without starting the app, so the first launch in that worktree does
not pay the cold Cargo build cost.

## Development

```bash
pnpm build                              # build the desktop app
pnpm test                               # Vitest + Rust tests
pnpm lint                               # oxlint
pnpm format                             # oxfmt + cargo fmt
pnpm --filter @cadencr/desktop ts-check # TypeScript checks
pnpm --filter @cadencr/desktop knip     # unused export detection
```

Rust build artifacts are isolated in each checkout's `target/`. Development
profiles omit debug information and incremental state to keep each worktree's
disk footprint bounded; application logs are unaffected. Run
`pnpm rust:storage` to inspect disk use, or see
[CONTRIBUTING.md](./CONTRIBUTING.md#rust-build-storage) for cleanup commands.

## How it works

```text
packages/
├── desktop/                 # Electron shell + React frontend
├── service/                 # Rust API/WebSocket service, packaged as sidecar
├── claude-agent-sdk-rs/     # Claude Code transport SDK
├── codex-app-server-sdk-rs/ # Codex transport SDK
├── opencode-sdk-rs/         # OpenCode transport SDK
├── cli-discovery/           # Local agent CLI discovery
└── landing/                 # Marketing site, docs, and news
```

- **Desktop ↔ Service**: HTTP for requests and WebSocket for live updates.
- **Service ↔ Agents**: provider adapters call local CLIs through focused Rust SDKs.
- **Work isolation**: sessions run in Git worktrees so parallel work stays separated.
- **Local-first**: everything runs on your machine and sends no telemetry; remote access is opt-in over your own LAN or Tailscale.
- **Release flow**: tagged desktop releases build, sign, notarize, and publish macOS artifacts from GitHub Actions.

## Open an issue or contribute

- Found a bug or have a feature idea? [Open an issue](https://github.com/merkr-software/CadencR/issues/new/choose).
- Have a question or want to share what you built? [Start a discussion](https://github.com/merkr-software/CadencR/discussions).
- Want to contribute? Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Please follow the [Code of Conduct](./.github/CODE_OF_CONDUCT.md).
- Security reports should use [GitHub private vulnerability reporting](https://github.com/merkr-software/CadencR/security/advisories/new).

## License

[Apache 2.0](./LICENSE): free and open source. Bring your own Claude Code, OpenCode, or Codex credentials.
