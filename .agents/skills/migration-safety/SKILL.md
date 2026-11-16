---
name: migration-safety
description: Use when writing or modifying Cadencr SQLite/sqlx migrations, especially destructive migrations, schema rebuilds, FK changes, or data cleanup.
---

# Migration Safety

Migrations can brick a user's local installation. Treat every existing database shape as production data, including old dev-era inconsistencies.

## Required Flow

1. Read `packages/service/migrations/AGENTS.md` and inspect nearby migrations.
2. Identify every affected table, FK, trigger, index, and child table:
   - `PRAGMA table_info(<table>)`
   - `PRAGMA foreign_key_list(<table>)`
   - `rg "REFERENCES <table>|<table>" packages/service/migrations packages/service/src`
3. Write a failing migration test before editing SQL. The fixture must model the risky old shape, not only a fresh happy-path DB.
4. Make the smallest migration change that fixes the root cause.
5. Verify on automated tests and copied real DB files. Never mutate the user's real dev or production DB for verification.

## Test Requirements

Every migration that deletes rows, drops tables/columns, rebuilds tables, changes FKs, or normalizes data needs a regression test in the Rust migration test harness.

The test should cover:
- Fresh schema behavior when relevant.
- A pre-migration schema with realistic legacy data.
- Existing orphaned or inconsistent rows if the migration touches cleanup.
- Child rows on both sides of every FK relation.
- `PRAGMA foreign_keys = ON`.
- `PRAGMA foreign_key_check` returns no rows after migration.

For sqlx migrations, seed `_sqlx_migrations` so only the target migration and later migrations run when testing historical fixtures.

## Verification Checklist

Before claiming a migration is safe, run the relevant subset:

```bash
cargo test -p cadencr-service shared::migrate
```

If a dev or packaged DB exists, verify against a temp copy only:

```bash
cp "packages/service/cadencr.local.db" /private/tmp/cadencr-migration-check.db
sqlite3 /private/tmp/cadencr-migration-check.db -cmd "PRAGMA foreign_keys=ON" -cmd ".bail on" ".read packages/service/migrations/<migration>.sql"
sqlite3 /private/tmp/cadencr-migration-check.db "PRAGMA foreign_keys=ON; PRAGMA foreign_key_check;"
```

For packaged DBs, use a temp copy of the production DB — `~/.cadencr/database/cadencr.db` on macOS, `$XDG_DATA_HOME/cadencr/database/cadencr.db` (default `~/.local/share/cadencr/database/cadencr.db`) on Linux.

## Red Flags

- Testing only a fresh empty DB.
- Dropping or rebuilding a parent table while live children still reference it.
- Deleting parent rows before deleting every child reference.
- Checking only one FK column when a table has multiple FKs into the same parent.
- Assuming `ON DELETE CASCADE` exists without checking the actual old schema.
- Ignoring orphan rows because "they should not exist".
- Editing an already-released migration without considering sqlx checksum history.

If a migration has already shipped to users, prefer a new forward repair migration. Only edit an existing migration when it has not been released or when the team explicitly accepts the checksum implications.
