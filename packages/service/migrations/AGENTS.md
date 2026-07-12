<!-- auto-generated from .claude/rules/ — edit those files and run pnpm build:agents-md -->

# AGENTS.md

These rules apply to SQL migrations in `packages/service/migrations/`.

### database
_Applies to: `packages/service/src/shared/db.rs`, `packages/service/src/shared/migrate.rs`, `packages/service/migrations/**`_

Schema migrations are managed by sqlx in the Rust service (`packages/service/migrations/`). New migrations use timestamp-based naming: `YYYYMMDDHHMMSS_description.sql`. They are embedded at compile time via `sqlx::migrate!()` and run automatically on server startup. Migrations are non-reversible (plain `.sql`, not `.up.sql`/`.down.sql`).
