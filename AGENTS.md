# AGENTS.md

Shared repository instructions for Codex and OpenCode. Claude Code uses `CLAUDE.md` instead.

The `## Rules` section below is **auto-generated** from `.claude/rules/*.md` — do not edit it manually. Run `pnpm build:agents-md` to regenerate it.

## Monorepo Structure

Cadencr is a desktop IDE that wraps multiple AI coding agents (Claude Code, Codex, Cursor, OpenCode) behind a unified workspace. pnpm workspaces + Turborepo; React/Electron frontend, Rust backend, Rust SDKs.

| Package | Stack | Purpose |
|---|---|---|
| `packages/desktop/` | Electron + React | Desktop shell and frontend (`@cadencr/desktop`) |
| `packages/service/` | Rust (axum, utoipa) | Backend API; runs as the Electron sidecar in packaged builds |
| `packages/*-sdk-rs/` | Rust | Per-provider SDKs (`claude-agent`, `codex-app-server`, `cursor-agent`, `opencode`) — transport only |
| `packages/cli-discovery/` | Rust | Detects locally installed agent CLIs |
| `packages/brand/` | TS | Brand source of truth; generates icons and social assets |
| `packages/landing/` | Astro | Marketing site, docs, roadmap |

Frontend path alias: `@` → `packages/desktop/src/`. Frontend ↔ backend is HTTP (Axios, generated client) for requests and a WebSocket for streaming updates.

## Gotchas

**Never remove any database.** Not the dev DB, not the production DB, not a custom `CADENCR_DB_PATH` — never delete, truncate, overwrite, or replace a database file. No exceptions.

**Never roll back without explicit approval.** Do not reset, revert, or restore away changes unless the user has sent exactly: `I approve this rollback`. Paraphrases do not count.

**Never run bare `cargo`.** Use `pnpm rust -- <args>` (or `node scripts/cargo-env.mjs cargo …`). The wrapper pins `CARGO_TARGET_DIR` to this worktree and strips `RUSTC_WRAPPER`/`SCCACHE_*`; bare cargo triggers a cold rebuild and mixes artifacts across branches.

**`pnpm start` is not an alias for `pnpm dev`.** `start` is desktop-only: it builds the service binary once and never runs it, so the frontend talks to nothing unless a service is already up. `pnpm dev` runs both (plus the landing site). The first `pnpm dev` in a fresh worktree cold-builds the whole Rust tree — `pnpm dev:precompile` does that ahead of time.

**Dev needs both `.env` files.** Debug builds of the service hard-fail without `packages/service/.env` (`CADENCR_DB_PATH`, `CADENCR_RUST_PORT`, `CADENCR_FRONTEND_PORT`, `CADENCR_AUTH_TOKEN`). `CADENCR_AUTH_TOKEN` must equal desktop's `VITE_API_TOKEN` or every request 401s — the client sends it as the `X-Cadencr-Token` header, not `Authorization`. Defaults: `1420` frontend, `5005` service.

**sqlx runs queries at runtime, not compile time.** The service uses `sqlx::query(...)` exclusively — no `query!`/`query_as!` macros, no `DATABASE_URL` needed to build, no `.sqlx/` offline dir. Don't introduce the macros.

**Warnings are errors.** The Cargo workspace denies `dead_code`, `unused_imports`, and `unused_variables`, so scaffolding an unused helper breaks the build.

**A new Rust endpoint takes three edits, not one.** It stays invisible to the frontend until it is (1) merged into `build_api_routes()` in `packages/service/src/api/mod.rs`, (2) listed in `paths(...)` / `components(schemas(...))` in `packages/service/src/api/openapi.rs`, and (3) picked up by `pnpm --filter @cadencr/desktop run generate:api` — commit the regenerated `packages/desktop/src/api/generated/index.ts`. Hook-name overrides live in `packages/desktop/orval.transformer.cjs`.

**One error shape.** Handlers return `AppError` (`packages/service/src/error.rs`), serialized as `{error, code}` with a stable SCREAMING_SNAKE code; `sqlx::Error` converts automatically. Don't invent new shapes.

**One WS envelope.** Every message in both directions is `WsEnvelope { id, domain, action, ref, payload }` (`packages/service/src/domain/ws_session/protocol.rs`); replies echo `ref`. Stream payloads carry a monotonic `seq` — the frontend detects gaps and resyncs (`packages/desktop/src/stores/ws-*.ts`).

**Adding a provider is one registry edit.** `static ADAPTERS` in `packages/service/src/domain/agents/providers/mod.rs`. SDK crates carry transport only; provider-specific behavior belongs in that provider's adapter.

**Check `packages/service/src/shared/` first** (`git_cli`, `worktree_paths`, `slug`, `db`, `env`) before writing a backend helper.

**Generated files are never hand-edited:** `packages/desktop/src/routes/routeTree.gen.ts` (TanStack Router) and `packages/desktop/src/api/generated/index.ts` (orval — committed). `packages/service/openapi.json` is derived and gitignored.

**New dependencies are gated.** `pnpm-workspace.yaml` sets a strict `minimumReleaseAge` (14 days) plus `blockExoticSubdeps` and `trustPolicy: no-downgrade` — a freshly published package is rejected unless added to `minimumReleaseAgeExclude`.

**Editing `.claude/rules/*.md` requires `pnpm build:agents-md`.** Pre-commit runs it with `--check` and hard-fails on a stale `AGENTS.md`.

**Remote access needs a pre-built renderer.** Vite's dev server can't serve it: set `CADENCR_RENDERER_DIR=../desktop/out/renderer` and rebuild after every frontend change.

## Commands

Requires `pnpm` and Node `>=22.18.0 <23.0.0`; `pnpm dev` needs `cargo-watch`.

```bash
pnpm dev            # frontend + service (+ landing)
pnpm start          # desktop only — no service watcher
pnpm rust -- test   # any cargo command (never bare `cargo`)
pnpm build          # build the desktop app
pnpm test           # turbo test (vitest + cargo test) plus scripts/*.test.mjs
pnpm lint           # oxlint + cargo check
pnpm format         # oxfmt + cargo fmt
pnpm --filter @cadencr/desktop ts-check
pnpm --filter @cadencr/desktop knip   # unused exports
```

Pre-commit runs `format:check lint ts-check test knip` across the workspace, so `knip` is not optional.

## Definition of done

- **Checks pass:** `ts-check`, `lint`, and the relevant tests.
- **Verified in the running app.** Any behavior change must be exercised against a live `pnpm dev`: real API calls for backend changes, real UI interaction for frontend changes. "It compiles", "tests pass", and "the code looks right" are not done.

## Scoped Rules

Additional scoped rules for specific directories:

- `packages/desktop/src/AGENTS.md`
- `packages/desktop/src/components/AGENTS.md`
- `packages/desktop/src/routes/AGENTS.md`
- `packages/service/migrations/AGENTS.md`

## Shared Skills

Project-specific skills use agent-skills-compatible directories:

- Codex and OpenCode can load `.agents/skills/*/SKILL.md`
- Claude Code loads `.claude/skills/*/SKILL.md`

If a task clearly matches one of these skills, read the matching skill and follow it before editing:

- `db`
- `finish-job`
- `keyboard-shortcuts`
- `migration-safety`
- `qa`
- `release`

## Command Aliases

- `/qa [feature]`: run the QA workflow from `.agents/skills/qa/SKILL.md`
- `/finish-job [scope or notes]`: simplify the current implementation, close test coverage gaps, propose a commit plan, wait for approval, then execute the safe commit flow

For agents that do not support project slash commands natively, treat these as semantic aliases and follow the mapped skill. For Codex specifically, if `/finish-job` appears in a prompt treat it as a plain-language alias for the `finish-job` skill in `.agents/skills/finish-job/`.

## Rules

<!-- begin:rules -->

### bon-builders
_Applies to: `**/*.rs`_

Cadencr is progressively standardizing Rust construction APIs on [`bon`](https://bon-rs.com/).

- New or modified builder-style APIs must use `bon` (`#[derive(bon::Builder)]`, `#[bon::builder]`, or `#[bon::bon]`) instead of handwritten builders.
- Use a `bon` builder when positional construction would be ambiguous (especially several same-typed, optional, or defaulted values). Keep straightforward constructors with only one or two unambiguous inputs.
- When substantially changing an existing handwritten builder or long positional constructor, migrate it to `bon` in the same change; do not mass-rewrite unrelated code.
- Preserve existing defaults, invariants, visibility, and conversion ergonomics during migration, and test the generated construction API.
- Keep `bon.workspace = true` in every Rust package manifest; the version is centralized in the root `Cargo.toml`.

### components
_Applies to: `packages/desktop/src/components/**`_

shadcn/ui primitives live in the `ui/` subdirectory (new-york style, neutral base); everything else goes directly in `components/`. Don't hand-roll a button, dialog, dropdown, or input — check `ui/` first.

### database
_Applies to: `packages/service/src/shared/db.rs`, `packages/service/src/shared/migrate.rs`, `packages/service/migrations/**`_

Migrations live in `packages/service/migrations/`, named `YYYYMMDDHHMMSS_description.sql`. They are plain, non-reversible `.sql` (no `.up`/`.down`), embedded via `sqlx::migrate!()` and run on server startup — so a released migration can never be edited, only followed by another one. For destructive changes, schema rebuilds, FK edits, or data cleanup, use the `migration-safety` skill.

### design-system
_Applies to: `packages/desktop/**`_

`DESIGN.md` (repo root) is the source of truth for Cadencr Desktop visual design: tokens, themes, typography, layout states, component anatomy, and iconography. Read it before changing user-facing UI, styling, or design tokens. If the implementation contradicts it, surface the mismatch instead of inventing a new visual rule.

### error-handling

Never swallow errors silently — no empty catch blocks, no `catch (_) {}`, no log-only handling. Surface every error to the user: a toast or inline message on the frontend, a meaningful error response on the backend.

### explicit-state
_Applies to: `**/*.tsx`, `**/*.ts`_

Every async operation needs visible loading state — a loader, skeleton, or progress indicator. An unacknowledged wait reads as a frozen app.

### file-size

Max 400 lines per file and 100 lines per function — past that, split into modules/components or smaller named functions. Test files are exempt.
(oxlint `max-lines` / `max-lines-per-function` enforce this for TS — see .oxlintrc.json; a PostToolUse hook in .claude/settings.json checks `.rs` files. The service stays under the limit with a `foo.rs` + sibling `foo/` directory layout.)

### frontend-performance
_Applies to: `packages/desktop/src/**`_

This is an IDE; users expect IDE-level responsiveness. Treat a perf regression on a hot path (agent stream, terminal, editor, long lists) as a correctness bug.

- **Always select from Zustand stores.** `useFooStore()` with no selector subscribes the consumer to every mutation, on every session. Select the slice you read — `useFooStore((s) => s.fieldA)` — and reach for `useFooStore.getState()` for actions that shouldn't drive renders.
- **Stabilize hook return values.** A hook that returns a fresh object literal each render breaks every downstream `useMemo` and `React.memo`. Wrap the return in `useMemo`, or split state and actions into separate hooks.
- **`React.memo` hot-path components** and keep their props stable (`useCallback` for callbacks, `useMemo` for objects/arrays). Anything mounted next to a streaming source or kept alive in a hidden tab qualifies.
- **Virtualize any list whose size scales with user data** — chat, logs, file trees, diff lists — with `react-virtuoso` or `@tanstack/react-virtual`.
- **Bound main-thread work.** Cache, gate by viewport, or offload synchronous parsing, highlighting, and markdown rendering at mount. Code-split heavy modules (CodeMirror, grammars, decoders) behind dynamic `import()` or `React.lazy`.
- **Gate layout reads** (`scrollHeight`, `getBoundingClientRect`) — never on every render or every resize event.

Before adding a tab, panel, or component under the agent/editor/terminal area, check how often it re-renders during streaming.

### inline-rust-tests
_Applies to: `**/*.rs`_

Keep Rust unit tests inline, behind `#[cfg(test)]` in the file they cover — no sibling `tests.rs`. If a module needs more room, split the production code into smaller modules and keep each one's tests with it. Integration tests live in `packages/service/tests/`.

### keyboard-shortcuts
_Applies to: `**/*.tsx`_

Power users drive this app from the keyboard, so a feature that can only be triggered by mouse is incomplete if a binding would make sense. When adding one, use the `keyboard-shortcuts` skill — the registry pipeline has non-QWERTY (`e.code` vs `e.key`) and help-modal requirements that are easy to get wrong.

### no-destructive-ops

**Never remove any database.** Never delete, truncate, overwrite, replace, or `rm` a Cadencr database file — not the dev DB (`packages/service/cadencr.local.db`), not the production DB (`~/.cadencr/database/cadencr.db`), not any custom `CADENCR_DB_PATH` / `--db-path` target. There is no exception for "just resetting local state" or "it's only the dev DB."

**Never roll back changes without explicit user approval.** Do not `git reset`, `git revert`, `git checkout --` / `git restore`, or otherwise undo committed or uncommitted work unless the user has replied with exactly this phrase: `I approve this rollback`. Paraphrases, implied consent, "go ahead", or approving a related plan do not count.

### no-optimistic-updates
_Applies to: `packages/desktop/src/**`_

No optimistic updates. Everything runs locally — there is no latency to hide, and optimism creates a second source of truth. Zustand state changes only when the backend confirms via a WebSocket event; never set status inside an action dispatcher (`startPlan()`, `approvePlan()`, …).

Session/agent status has exactly one source: `useSessionStatusStore` (`@/stores/session-status-store`), populated only by `session_status.update` / `session_status.snapshot` (`LiveAgentStatus`: `"idle" | "agent" | "question"`). Read "is the agent working?" from there — never re-derive or track it separately.

### platform-support

CadencR Desktop is a supported product on both macOS and Linux. Treat both platforms as first-class whenever changing shared application behavior.

- Prefer platform-neutral implementations. For filesystem paths, process spawning, shell commands, executable discovery, keyboard modifiers, updater behavior, packaging, native dialogs, window chrome, and Electron/runtime integration, explicitly evaluate the behavior on both macOS and Linux.
- Add automated coverage for every platform-specific branch whenever practical. Keep platform detection at a narrow boundary instead of scattering OS checks through shared code.
- Before reporting work complete, explicitly tell the user which macOS- and Linux-specific tests were run, which were automated, and which still require validation on a real platform or packaged artifact. Never imply that a test on one operating system proves behavior on the other.
- If a change requires a dedicated platform test that cannot be run in the current environment, call that out clearly as a remaining verification requirement rather than silently omitting it.

### provider-boundaries
_Applies to: `packages/service/src/**`, `packages/desktop/src/**`, `packages/*-sdk-rs/src/**`_

Cadencr is provider-neutral by design — don't scatter provider-specific logic across shared codepaths.

- `packages/*-sdk-rs/` crates carry transport and protocol details only.
- Provider-specific business logic belongs in that provider's backend adapter (`packages/service/src/domain/agents/providers/`).
- Shared backend runtime, workflow, and API code consumes the unified adapter interface and provider-neutral types.
- Shared frontend components, hooks, and stores consume provider-neutral catalog/config data — no hardcoded provider branches.

When a provider needs special handling, extract it into a dedicated provider file or folder rather than adding another conditional to generic code.

### routes
_Applies to: `packages/desktop/src/routes/**`_

Do not edit `routeTree.gen.ts` — it is auto-generated by TanStack Router from the file-based routes.

### strict-typing
_Applies to: `**/*.ts`, `**/*.tsx`_

Never use `any` — use `unknown` and narrow with type guards, and validate external boundaries with Zod. (`typescript/no-explicit-any` is a hard oxlint error, so this fails the build, not just review.)

<!-- end:rules -->
