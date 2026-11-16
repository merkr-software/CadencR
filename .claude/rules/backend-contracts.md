---
paths:
  - "**/*.rs"
  - "packages/desktop/src/api/**"
  - "packages/desktop/src/stores/ws-*.ts"
---

- The Cargo workspace denies `dead_code`, `unused_imports`, and `unused_variables`; unused scaffolding breaks the build.
- The service uses runtime `sqlx::query(...)`, never `query!`/`query_as!`. Builds need neither `DATABASE_URL` nor a `.sqlx/` offline directory.
- Before adding a backend helper, check `packages/service/src/shared/` (`git_cli`, `worktree_paths`, `slug`, `db`, `env`).
- New Rust endpoints must be merged into `build_api_routes()` in `packages/service/src/api/mod.rs`, registered in `paths(...)` / `components(schemas(...))` in `packages/service/src/api/openapi.rs`, and picked up by `pnpm --filter @cadencr/desktop run generate:api`. Commit the regenerated `packages/desktop/src/api/generated/index.ts`; never edit it by hand. Hook-name overrides live in `packages/desktop/orval.transformer.cjs`. `packages/service/openapi.json` is derived and gitignored.
- Handlers return `AppError` (`packages/service/src/error.rs`), serialized as `{error, code}` with a stable SCREAMING_SNAKE code. `sqlx::Error` converts automatically; do not invent another error shape.
- Every WebSocket message uses `WsEnvelope { id, domain, action, ref, payload }` (`packages/service/src/domain/ws_session/protocol.rs`). Replies echo `ref`. Stream payloads carry a monotonic `seq`; the frontend detects gaps and resyncs (`packages/desktop/src/stores/ws-*.ts`).
