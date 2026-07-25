-- Long-lived, aggregate record of how many words the user exchanged with each
-- provider / model / thinking-effort combination.
--
-- Deliberately has NO foreign key to features or agent_sessions: the whole
-- point is that the numbers survive archiving a feature or deleting a
-- conversation. Nothing here can be traced back to a specific conversation —
-- only counters per (UTC day, provider, model, effort).
--
-- Rows are upserted (one per bucket per day), not appended per turn, so the
-- table stays bounded no matter how heavily the app is used: roughly
-- days × providers × models × efforts.
--
-- `model_id` / `thinking_effort` are NOT NULL with an empty-string default
-- rather than nullable, because NULL never compares equal in a UNIQUE index
-- and would silently break the upsert into an append.
CREATE TABLE provider_usage_stats (
    day TEXT NOT NULL,                            -- 'YYYY-MM-DD', UTC
    provider_id TEXT NOT NULL,                    -- e.g. 'claude_code', 'codex'
    model_id TEXT NOT NULL DEFAULT '',            -- '' when the provider never reported one
    thinking_effort TEXT NOT NULL DEFAULT '',     -- '' when the model has no effort levels
    input_words INTEGER NOT NULL DEFAULT 0,       -- words sent to the provider
    output_words INTEGER NOT NULL DEFAULT 0,      -- words received from the provider
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (day, provider_id, model_id, thinking_effort)
);

-- Drives the settings timeline query, which always scans a trailing window.
CREATE INDEX idx_provider_usage_stats_day ON provider_usage_stats(day);
