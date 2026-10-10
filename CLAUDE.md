# CLAUDE.md

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

**Dev needs both `.env` files.** Debug builds of the service hard-fail without `packages/service/.env` (`CADENCR_DB_PATH`, `CADENCR_RUST_PORT`, `CADENCR_FRONTEND_PORT`, `CADENCR_AUTH_TOKEN`). `CADENCR_AUTH_TOKEN` must equal desktop's `VITE_API_TOKEN` or every request 401s — the client sends it as the `X-Cadencr-Token` header, not `Authorization`. Defaults: `1420` frontend, `5005` service. `pnpm setup:dev` creates both with one shared token (in a linked worktree use `pnpm dev:configure-worktree`, which also assigns per-worktree ports); `pnpm doctor` diagnoses token/port drift, toolchain, watcher and Electron.

**sqlx runs queries at runtime, not compile time.** The service uses `sqlx::query(...)` exclusively — no `query!`/`query_as!` macros, no `DATABASE_URL` needed to build, no `.sqlx/` offline dir. Don't introduce the macros.

**Warnings are errors.** The Cargo workspace denies `dead_code`, `unused_imports`, and `unused_variables`, so scaffolding an unused helper breaks the build.

**A new Rust endpoint takes three edits, not one.** It stays invisible to the frontend until it is (1) merged into `build_api_routes()` in `packages/service/src/api/mod.rs`, (2) listed in `paths(...)` / `components(schemas(...))` in `packages/service/src/api/openapi.rs`, and (3) picked up by `pnpm --filter @cadencr/desktop run generate:api` — commit the regenerated `packages/desktop/src/api/generated/index.ts`. Hook-name overrides live in `packages/desktop/orval.transformer.cjs`.

**One error shape.** Handlers return `AppError` (`packages/service/src/error.rs`), serialized as `{error, code}` with a stable SCREAMING_SNAKE code; `sqlx::Error` converts automatically. Don't invent new shapes.

**One WS envelope.** Every message in both directions is `WsEnvelope { id, domain, action, ref, payload }` (`packages/service/src/domain/ws_session/protocol.rs`); replies echo `ref`. Stream payloads carry a monotonic `seq` — the frontend detects gaps and resyncs (`packages/desktop/src/stores/ws-*.ts`).

**Adding a built-in provider is one registry edit.** `BUILTIN_PROVIDERS` in `packages/service/src/domain/agents/providers/registry.rs` — an ordered factory table; registration order is user-visible. Lookups go through `provider_registry()` / `runtime_adapter()`, which return a `ProviderAdapterHandle` (owned, `'static`, `Deref`s to the trait). SDK crates carry transport only; provider-specific behavior belongs in that provider's adapter directory (`agents/<provider>/`).

**Adding an ACP provider is no code edit at all.** `ProviderRegistry::startup()` appends every enabled descriptor under `<settings-dir>/providers/*.json` (`agents/providers/installed/`), each backed by the one `GenericAcpAdapter`. Descriptors are read once at startup and must name a local executable — no downloads, no reload. A descriptor may not declare models, modes, permissions, or auth: those are negotiated over ACP. Built-ins register first, so a descriptor can never take their ids; refusals surface with a stable code at `GET /api/agents/installed-providers`.

**Check `packages/service/src/shared/` first** (`git_cli`, `worktree_paths`, `slug`, `db`, `env`) before writing a backend helper.

**Generated files are never hand-edited:** `packages/desktop/src/routes/routeTree.gen.ts` (TanStack Router) and `packages/desktop/src/api/generated/index.ts` (orval — committed). `packages/service/openapi.json` is derived and gitignored.

**New dependencies are gated.** `pnpm-workspace.yaml` sets a strict `minimumReleaseAge` (14 days) plus `blockExoticSubdeps` and `trustPolicy: no-downgrade` — a freshly published package is rejected unless added to `minimumReleaseAgeExclude`.

**Editing `.claude/rules/*.md` requires `pnpm build:agents-md`.** Pre-commit runs it with `--check` and hard-fails on a stale `AGENTS.md` (the Codex/OpenCode mirror).

**Remote access needs a pre-built renderer.** Vite's dev server can't serve it: set `CADENCR_RENDERER_DIR=../desktop/out/renderer` and rebuild after every frontend change.

## Commands

```bash
pnpm dev            # frontend + service (+ landing); needs watchexec (cargo-watch fallback)
pnpm start          # desktop only — no service watcher
pnpm rust -- test   # any cargo command (never bare `cargo`)
pnpm build          # build the desktop app
pnpm test           # turbo test (vitest + cargo test --workspace) plus scripts/*.test.mjs
pnpm lint           # provider boundaries + oxlint + clippy --workspace
pnpm format         # oxfmt + cargo fmt
pnpm doctor         # check Node, pnpm, Rust, watcher, .env files, Electron
pnpm --filter @cadencr/desktop ts-check
pnpm --filter @cadencr/desktop knip   # unused exports
pnpm --filter @cadencr/desktop exec vitest related --run src/x.ts   # tests covering a file
```

Node `>=22.19.0 <23.0.0` (`.nvmrc` pins 22.19.0). Pre-commit (`scripts/pre-commit.mjs`) runs only the checks the staged files can affect — `node scripts/pre-commit.mjs --dry-run` shows the plan, `CADENCR_PRECOMMIT_FULL=1` forces everything. CI always runs the full set, so `knip` is not optional.

## Definition of done

- **Checks pass:** `ts-check`, `lint`, and the relevant tests.
- **Verified in the running app.** Any behavior change must be exercised against a live `pnpm dev`: real API calls for backend changes, real UI interaction for frontend changes. "It compiles", "tests pass", and "the code looks right" are not done.

Use the `qa` skill to drive the UI, and `finish-job` to simplify, check coverage, and prepare a commit.

## Going deeper

- `DESIGN.md` — source of truth for desktop visual design (tokens, themes, typography, component anatomy). Read before user-facing visual work.
- `docs/REWIND_AND_FORK.md`, `docs/PROVIDER_SPEC/` — subsystem specs (`INSTALLED_ACP_PROVIDERS.md` is the local ACP descriptor format). `CONTRIBUTING.md` — contribution workflow.
- Skills: `db`, `qa`, `release`, `migration-safety`, `keyboard-shortcuts`, `finish-job`.
- `.claude/rules/*.md` — path-scoped rules that load automatically when you touch matching files.
