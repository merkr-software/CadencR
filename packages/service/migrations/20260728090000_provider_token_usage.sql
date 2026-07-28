-- Provider-native token accounting supersedes the original word estimates.
-- Keep the old columns in place so this migration is additive and preserves
-- existing databases; the API and recorder use only these new token columns.
ALTER TABLE provider_usage_stats
    ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_usage_stats
    ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

-- Durable, provider-scoped checkpoints make cumulative counters idempotent
-- across reconnects, provider switches, and service restarts.
CREATE TABLE provider_usage_checkpoints (
    session_id INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, provider_id),
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

-- Per-turn reports can be replayed when a runtime resumes. Keep every stable
-- event id, not just the latest one, so non-consecutive replays are idempotent.
CREATE TABLE provider_usage_events (
    session_id INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (session_id, provider_id, event_id),
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);
