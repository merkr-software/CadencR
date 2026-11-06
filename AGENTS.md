# AGENTS.md

Cadencr is a desktop IDE for multiple AI coding agents: pnpm/Turborepo, React/Electron frontend, Rust backend and SDKs. Cursor and Codex read this file; `CLAUDE.md` imports it for Claude Code.

## Start Here

- Read the rules marked **Every task** below, then the rules whose paths match the files you will work on. Their paths are relative to the repository root. If a rule is already loaded in context (including Claude's native `.claude/rules/`), use it without reading a second copy.
- Read any more-specific `AGENTS.md` on the path to files you edit, even when the session started at the root. Scoped files contain links to the same rule sources.
- For setup, worktrees, commit conventions, or PRs, read the relevant section of [CONTRIBUTING.md](CONTRIBUTING.md). For desktop visual work, read [DESIGN.md](DESIGN.md). For rewind/fork behavior, read `docs/REWIND_AND_FORK.md`.

## Safety

- Never delete, truncate, overwrite, or replace a Cadencr database, including development, production, and custom `CADENCR_DB_PATH` targets.
- Never reset, revert, restore away, or otherwise roll back committed or uncommitted work unless the user has sent exactly `I approve this rollback`.

These two constraints stay visible here even before the detailed rules are loaded.

## Repository Map

- `packages/desktop/`: Electron + React (`@cadencr/desktop`); `@` aliases `src/`. Frontend/backend requests use HTTP (Axios, generated client) and updates use WebSocket.
- `packages/service/`: Rust backend (axum, utoipa), packaged as the Electron sidecar. Check `src/shared/` before adding helpers.
- `packages/*-sdk-rs/`: provider transport/protocol only; business behavior belongs in the service adapters. `packages/cli-discovery/` detects agent CLIs.
- `packages/brand/`: brand assets; `packages/landing/`: Astro marketing site and docs. Consult package manifests for the remaining workspace tools.

## Commands

Use pnpm and the Node version pinned by `.nvmrc` (`>=22.19.0 <23.0.0`).

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Desktop, service watcher, and landing site; requires `watchexec` or `cargo-watch` |
| `pnpm build` | Build the desktop app |
| `pnpm test` | Workspace tests plus root script tests |
| `pnpm lint` | Provider boundaries, test-schema ratchet, oxlint, and workspace clippy |
| `pnpm format` / `pnpm format:check` | Format / verify formatting |
| `pnpm doctor` | Diagnose toolchain, environment, ports, watcher, and Electron |
| `pnpm rust -- <args>` | All Cargo commands; never run bare `cargo` |

The Rust wrapper isolates `CARGO_TARGET_DIR` per worktree and strips `RUSTC_WRAPPER` / `SCCACHE_*`. Use package-scoped checks and related tests from [CONTRIBUTING.md](CONTRIBUTING.md#common-commands) during iteration.

## Development Gotchas

- `pnpm start` runs the desktop only: it builds the service binary but does not run the service or its watcher. Use `pnpm dev` for a working stack. `pnpm dev:precompile` warms the Rust build in a fresh worktree.
- Debug service builds require `packages/service/.env`; the desktop also needs its own `.env`. `CADENCR_AUTH_TOKEN` must equal desktop's `VITE_API_TOKEN` (sent as `X-Cadencr-Token`, not `Authorization`). Required service keys also include `CADENCR_DB_PATH`, `CADENCR_RUST_PORT`, and `CADENCR_FRONTEND_PORT`. Defaults: frontend `1420`, service `5005`. Use `pnpm setup:dev`, or `pnpm dev:configure-worktree` in a linked worktree, to create matching configuration. Never commit `.env` files.
- Remote access requires a built renderer: set `CADENCR_RENDERER_DIR=../desktop/out/renderer` and rebuild after frontend changes; Vite's dev server cannot serve it.
- Dependency policy in `pnpm-workspace.yaml` enforces a 14-day `minimumReleaseAge`, `blockExoticSubdeps`, and `trustPolicy: no-downgrade`. Fresh packages require an explicit `minimumReleaseAgeExclude` entry.

## Validation

- Run the checks affected by the change: relevant tests, lint, type checks, and `knip` for frontend changes. Desktop types: `pnpm --filter @cadencr/desktop ts-check`; unused exports: `pnpm --filter @cadencr/desktop knip`. CI runs the full set; scoped local checks do not replace CI.
- Exercise application behavior changes against live `pnpm dev`: real API calls for backend changes and real UI interactions for frontend changes. Use the `qa` skill for UI verification. Documentation-only changes need document/generator checks, not an app launch.
- When changing shared application behavior, verify macOS and Linux paths and report which checks ran and which platform checks remain. See the platform rule for details.

## Skills

Shared sources live in `.agents/skills/<name>/SKILL.md`; `.claude/skills/` contains tracked links to those same sources. Read the matching skill before its workflow. Cursor and Codex can discover `.agents/skills/` directly.

| Task | Skill |
| --- | --- |
| Query or modify the Cadencr database | `db` |
| Validate running app behavior | `qa` |
| Prepare/publish a release | `release` |
| Change destructive migrations, schema rebuilds, or foreign keys | `migration-safety` |
| Add or modify keyboard shortcuts | `keyboard-shortcuts` |
| Simplify, verify, and prepare commits | `finish-job` |

Treat `/qa` and `/finish-job` as invocations of those skills even when the agent does not provide native slash commands. `finish-job` includes its own commit-plan approval step.

## Rules

This index is generated from `.claude/rules/*.md`; edit those sources and run `pnpm build:agents-md`. Rule bodies are loaded only when relevant, not copied into this file. The same applies to scoped `AGENTS.md` files. Preserve tool-managed blocks outside the markers.

<!-- begin:rules -->

| Rule source | Applies to (repository-relative) |
| --- | --- |
| [backend-contracts](.claude/rules/backend-contracts.md) | `**/*.rs`, `packages/desktop/src/api/**`, `packages/desktop/src/stores/ws-*.ts` |
| [bon-builders](.claude/rules/bon-builders.md) | `**/*.rs` |
| [components](.claude/rules/components.md) | `packages/desktop/src/components/**` |
| [database](.claude/rules/database.md) | `packages/service/src/shared/db.rs`, `packages/service/src/shared/migrate.rs`, `packages/service/migrations/**` |
| [design-system](.claude/rules/design-system.md) | `packages/desktop/**` |
| [error-handling](.claude/rules/error-handling.md) | Every task |
| [explicit-state](.claude/rules/explicit-state.md) | `**/*.tsx`, `**/*.ts` |
| [file-size](.claude/rules/file-size.md) | Every task |
| [frontend-performance](.claude/rules/frontend-performance.md) | `packages/desktop/src/**` |
| [inline-rust-tests](.claude/rules/inline-rust-tests.md) | `**/*.rs` |
| [keyboard-shortcuts](.claude/rules/keyboard-shortcuts.md) | `**/*.tsx` |
| [no-destructive-ops](.claude/rules/no-destructive-ops.md) | Every task |
| [no-optimistic-updates](.claude/rules/no-optimistic-updates.md) | `packages/desktop/src/**` |
| [platform-support](.claude/rules/platform-support.md) | Every task |
| [provider-boundaries](.claude/rules/provider-boundaries.md) | `packages/service/src/**`, `packages/desktop/src/**`, `packages/*-sdk-rs/src/**` |
| [routes](.claude/rules/routes.md) | `packages/desktop/src/routes/**` |
| [strict-typing](.claude/rules/strict-typing.md) | `**/*.ts`, `**/*.tsx` |

<!-- end:rules -->

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
