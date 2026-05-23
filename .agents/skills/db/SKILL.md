---
name: db
description: Query or modify the Cadencr SQLite database
user-invocable: true
allowed-tools: Bash(sqlite3 *)
---

# Cadencr Database

Cadencr stores its state in a SQLite file. There are two locations to be aware of:

| Context | Path | When |
|---|---|---|
| **Dev** (default) | `packages/service/cadencr.local.db` | When running `pnpm dev` — set by `CADENCR_DB_PATH=./cadencr.local.db` in `packages/service/.env`. |
| **Production** (packaged Electron) | macOS: `~/.cadencr/database/cadencr.db`. Linux: `$XDG_DATA_HOME/cadencr/database/cadencr.db` (default `~/.local/share/cadencr/database/cadencr.db`). | When the Electron sidecar spawns the service binary (see `packages/desktop/electron/main/sidecar.ts`). |
| Custom | Whatever `CADENCR_DB_PATH` / `--db-path` points at | Override either of the above. |

**Never remove any database** — not the dev DB, not the production DB, not a custom path. Never delete, truncate, overwrite, replace, or `rm` a database file. No exceptions.

Default to the **dev** path unless the user is clearly debugging the packaged app. If unsure, ask. Always wrap the path in double quotes — e.g. `sqlite3 "packages/service/cadencr.local.db"`.

## Tables

The dev DB currently contains these tables (run `.tables` to confirm — schema drifts as migrations land):

```
agent_messages              feature_settings
agent_sessions              features
claude_code_custom_models   project_settings
claude_code_profiles        projects
custom_action_runs          prompt_history
custom_action_schedules     session_runtime_ids
custom_action_variables     settings
custom_actions
diff_comments
diff_viewed_files
feature_layouts
```

(`_sqlx_migrations` and `migrations` are migration bookkeeping — leave them alone.)

For exact column lists, run `.schema <table>` instead of trusting documentation — the column set evolves. Common entry points:

- `projects` → `features` → `agent_sessions` → `agent_messages`
- `features` → `feature_layouts`, `feature_settings`
- `custom_actions` → `custom_action_runs`, `custom_action_schedules`, `custom_action_variables`
- `claude_code_profiles` → `claude_code_custom_models`

`features.status` is the remaining archive marker. Valid persisted values are
`active` and `archived`; archived features are hidden from the normal feature
lists but may still exist for migration/back-compat inspection.

## Usage

If `$ARGUMENTS` is a raw SQL query, run it directly. Otherwise interpret the user's intent and build the query.

When mutating, honor foreign-key relations:

- Deleting an `agent_sessions` row → also delete its `agent_messages` (and `session_runtime_ids` referencing it, if any).
- Resetting a `features` row → clean related `agent_sessions` (+ their messages), `feature_settings`, `diff_comments`, `diff_viewed_files`, `custom_action_*` entries as appropriate.

If you're not sure what depends on a row, inspect schemas with `.schema <table>` and search for `REFERENCES <target>` before deleting.

Always show results after mutations to confirm changes (e.g., follow an `UPDATE` with the matching `SELECT`).
