# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cadencr is a desktop IDE that wraps multiple AI coding agents (Claude Code, OpenCode, Codex) behind a unified workspace.

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

## Definition of done

Before claiming a task complete:

- **Checks pass.** Run `pnpm --filter @cadencr/desktop ts-check`, `pnpm lint`, and the relevant tests — vitest for the frontend, `cargo test` for Rust.
- **Verified end-to-end in the running app.** Any behavior change must be exercised against a live `pnpm dev` instance: for backend/API changes, make real API calls against the dev server; for frontend changes, drive the UI via the qa skill, the Cadencr browser MCP, or devtools. "It compiles", "tests pass", and "the code looks right" are not done. (If the Rust API surface changed, also regenerate and commit the client — see "Project-specific workflows" below.)

## Project-specific workflows

**Regenerating the API client.** After changing the Rust API surface (utoipa attributes / new handlers), run `pnpm --filter @cadencr/desktop run generate:api`. This re-emits `packages/service/openapi.json` (gitignored, derived from utoipa) and regenerates `packages/desktop/src/api/generated/index.ts` via orval — commit the regenerated TS file. Naming overrides for hooks live in `packages/desktop/orval.transformer.cjs`.
