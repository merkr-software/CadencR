# AGENTS.md

Shared repository instructions for Codex and OpenCode. Claude Code uses `CLAUDE.md` instead.

The `## Rules` section below is **auto-generated** from `.claude/rules/*.md` — do not edit it manually. Run `pnpm build:agents-md` to regenerate it.

## Monorepo Structure

pnpm workspaces + Turborepo. TypeScript frontend, Rust backend, and several Rust SDKs.

| Package | Stack | Purpose |
|---|---|---|
| `packages/desktop/` | Electron + React | Desktop shell and frontend (`@cadencr/desktop`) |
| `packages/service/` | Rust (axum, utoipa) | Backend API server; runs as Electron sidecar in packaged builds |
| `packages/claude-agent-sdk-rs/` | Rust | SDK for Claude Code agents |
| `packages/codex-app-server-sdk-rs/` | Rust | SDK for Codex agents |
| `packages/opencode-sdk-rs/` | Rust | SDK for OpenCode agents |
| `packages/cli-discovery/` | Rust | Detects locally installed agent CLIs |
| `packages/landing/` | Next.js | Marketing site, docs, roadmap |

## Agent Providers

Cadencr is provider-neutral by design. Each supported agent (Claude Code, OpenCode, Codex) has its own Rust SDK in `packages/*-sdk-rs/` that handles transport/protocol details only. Provider-specific business logic lives in adapters inside `packages/service/`; shared frontend and backend code consumes provider-neutral types and catalog data — never branch on provider identity in generic code.

## Workflow

Requires `pnpm`, Node `>=22.18.0 <23.0.0`, and `cargo-watch` for `pnpm dev`.

```bash
pnpm dev                                  # frontend + service via Turborepo (alias: pnpm start)
pnpm build                                # build the desktop app
pnpm test                                 # vitest (frontend) + cargo test (Rust)
pnpm lint                                 # oxlint
pnpm format                               # oxfmt + cargo fmt
pnpm --filter @cadencr/desktop ts-check   # TypeScript type-check
pnpm --filter @cadencr/desktop knip       # unused-export detection
```

Target a single package: `pnpm --filter @cadencr/desktop <task>`. Frontend/service ports are configured via `packages/desktop/.env` and `packages/service/.env` (defaults `1420` / `5005`).

## Architecture

Electron desktop shell with a React frontend. The backend is the Rust API server in `packages/service/`, spawned as a sidecar in production; in dev `pnpm dev` runs it alongside the frontend via Turborepo. Frontend ↔ backend communication is HTTP (Axios) for requests and WebSocket (Zustand store) for streaming updates. Folder selection uses Electron native dialogs through the preload bridge.

Frontend path alias: `@` → `packages/desktop/src/` (for example `import { foo } from "@/lib/foo"`).

## Design System

`DESIGN.md` is the source of truth for Cadencr Desktop visual design: tokens, themes, typography, layout states, component anatomy, iconography, and UI self-audit checks.

- Before changing frontend UI, layout, styling, design tokens, icons, or user-facing visual behavior, read `DESIGN.md` and preserve its constraints.
- Do not load or summarize `DESIGN.md` for backend-only, SDK-only, migration-only, or non-visual documentation work.
- If implementation and `DESIGN.md` conflict, pause and surface the mismatch instead of silently inventing a new visual rule.

## Project-specific workflows

**Regenerating the API client.** After changing the Rust API surface (utoipa attributes / new handlers), run `pnpm --filter @cadencr/desktop run generate:api`. This re-emits `packages/service/openapi.json` (gitignored, derived from utoipa) and regenerates `packages/desktop/src/api/generated/index.ts` via orval — commit the regenerated TS file. Naming overrides for hooks live in `packages/desktop/orval.transformer.cjs`.

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
- `migration-safety`
- `qa`
- `finish-job`

## Command Aliases

- `/qa [feature]`: run the QA workflow from `.agents/skills/qa/SKILL.md`
- `/finish-job [scope or notes]`: simplify the current implementation, close test coverage gaps, propose a commit plan, wait for approval, then execute the safe commit flow

For agents that do not support project slash commands natively, treat these as semantic aliases and follow the mapped skill. For Codex specifically, if `/finish-job` appears in a prompt treat it as a plain-language alias for the `finish-job` skill in `.agents/skills/finish-job/`.

## Rules

<!-- begin:rules -->

### components

shadcn/ui components go in `ui/` subdirectory (new-york style, neutral base). Custom components go directly in `components/`.

### database

Schema migrations are managed by sqlx in the Rust service (`packages/service/migrations/`). New migrations use timestamp-based naming: `YYYYMMDDHHMMSS_description.sql`. They are embedded at compile time via `sqlx::migrate!()` and run automatically on server startup. Migrations are non-reversible (plain `.sql`, not `.up.sql`/`.down.sql`).

### error-handling

Never swallow errors silently. Every error must be surfaced to the user — no empty catch blocks, no `catch (_) {}`, no logging-only without user-visible feedback. On the frontend, show a toast or inline error message. On the backend, return a meaningful error response. A no-op error handler is always wrong.

### explicit-state

Every async operation must have visible loading state. If the app is loading, fetching, or processing, the user must see a loader, skeleton, or progress indicator. Users should never stare at a seemingly frozen screen. An unacknowledged wait is a UX bug.

### file-size

No file longer than 400 lines. If a file grows past this, extract modules or components. Check file length before and after edits — if an edit would push a file over 400 lines, refactor first.

### frontend-performance

These rules apply to frontend code under `packages/desktop/src/`. The app is an IDE; technical users expect IDE-level responsiveness. Performance is a hard constraint, not an afterthought — think about render cost, subscription scope, and main-thread work *before* writing the change. The existing generic `performance.md` rule still applies; this one is the detailed, mandatory version for frontend code.

## Mandatory practices

- **Always select from Zustand stores.** Never call a store hook without a selector (`useFooStore()` subscribes the consumer to every mutation, on every session). Always select the slice you actually read: `useFooStore((s) => s.fieldA)`. Read actions outside the render flow via `useFooStore.getState()` when they don't need to drive UI updates.
- **Stabilize hook return values.** A custom hook that returns a fresh object literal each render breaks every downstream `useMemo` and `React.memo`. Wrap the return in `useMemo` keyed on the primitive fields it depends on, or split state and actions into separate hooks.
- **`React.memo` hot-path components.** Anything mounted next to a streaming source (agent stream, terminal, editor, long list) or kept alive in a hidden tab must be memoized. Verify props are stable — callbacks via `useCallback`, objects/arrays via `useMemo`.
- **Virtualize long lists.** Rendering hundreds of DOM nodes for a chat, log, file tree, or diff list is a bug. Use `react-virtuoso` or `@tanstack/react-virtual`. The agent stream, file trees, search results, and any list whose size scales with user data must be windowed.
- **Bound main-thread work.** Synchronous parsing, syntax highlighting, or markdown rendering at mount must be cached, gated by viewport, or offloaded (`requestIdleCallback`, Web Worker). No unbounded synchronous work on first paint.
- **Lazy-load heavy modules.** Editors (CodeMirror), syntax-highlighting grammars, image/video decoders, and any module > 100 KB gzipped must be code-split via dynamic `import()` or `React.lazy`.

## Forbidden patterns

- Subscribing a hot component to an entire store (no selector), or returning the raw store from a wrapper hook.
- Returning a fresh object literal from a custom hook without `useMemo`.
- Passing freshly-built objects, arrays, or arrow functions as props through a streaming or list-rendering parent — they defeat memoization on every descendant.
- Adding a new tab, panel, or component under the agent/editor/terminal area without auditing how often it re-renders during streaming.
- Running heavy computation inside the render body. Move it to `useMemo`, an effect, or off-thread.
- Triggering layout reads (`scrollHeight`, `getBoundingClientRect`, etc.) on every render or every resize event without gating.

When in doubt, profile first. Don't speculate; don't ignore. A perf regression on a hot path is treated like a correctness bug.

### function-size

No function longer than 100 lines. If a function exceeds this, split it into smaller, well-named functions. Before finishing an edit, check that no function in the modified file breaks this limit.

### inline-rust-tests

In Rust source files, keep unit tests inline with the code they cover. Do not create or expand dedicated sibling test files like `tests.rs` just to hold unit tests for a module. If a Rust module needs more room, split production code into smaller modules or files, but keep each module’s unit tests in the same source file behind `#[cfg(test)]`.

### keyboard-shortcuts

When adding a new user-facing feature, ask whether it needs a keyboard shortcut. Power users rely on keyboard navigation — don't ship a feature that can only be triggered by mouse if it could reasonably have a keybinding.

### no-optimistic-updates

Do NOT use optimistic updates in the frontend. Everything runs locally — there is no latency to hide. Optimistic updates create multiple sources of truth and add unnecessary complexity.

The Zustand store state must be the single source of truth. Only update store state when the backend confirms a change via WebSocket events. Never set state optimistically in action dispatchers — wait for the corresponding event from the backend.

### performance

Performance is critical — this app targets technical users who expect speed. Avoid unnecessary re-renders, heavy computations on the main thread, and redundant network calls. Lazy-load where appropriate. When in doubt, profile first.

### provider-boundaries

Do not scatter provider-specific logic across shared codepaths.

- Provider SDKs are only for provider communication details.
- Provider adapters are where provider-specific business logic should live on the backend.
- Shared backend runtime, workflow, and API code should consume unified adapter interfaces and provider-neutral types.
- Shared frontend components, hooks, and stores should consume provider-neutral catalog/config data instead of hardcoded provider branches.
- If a provider needs special handling, extract it into a dedicated provider file or folder rather than adding another provider-specific conditional in generic code.

### reusability

Always search for existing code before writing new code. Grep/glob for similar utilities, helpers, hooks, or components already in the codebase. Duplicate code is a bug — extract shared logic instead of copying.

### routes

Do not edit `routeTree.gen.ts` — it is auto-generated by TanStack Router from the file-based routes.

### simplicity

Keep code simple. If an approach feels complex, it will be hard to maintain — find a simpler way. Prefer straightforward, obvious implementations over clever ones. If you can't explain the approach in one sentence, it's too complicated.

### strict-typing

Never use `any` type. Use `unknown` when the type is truly uncertain, then narrow with type guards. All functions, parameters, and return values must have explicit types. Prefer interfaces for object shapes and use Zod schemas (already in the project) for runtime validation at boundaries.

<!-- end:rules -->
