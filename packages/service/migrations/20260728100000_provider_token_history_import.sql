-- Provider histories live outside Cadencr's SQLite database, so the SQL
-- migration can only establish durable, per-provider import state. Startup
-- performs the filesystem/database scan and marks each provider complete.
CREATE TABLE provider_usage_history_imports (
    provider_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    cutoff_at TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    events_imported INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (provider_id, version)
);
