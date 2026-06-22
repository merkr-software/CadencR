-- A user message queued to be delivered to a conversation at a future time.
-- Scheduling is server-side: a background poll loop dispatches due rows even if
-- no client is connected. `scheduled_at` is stored in SQLite UTC datetime
-- format ("YYYY-MM-DD HH:MM:SS") so it compares directly against
-- `datetime('now')`; callers send ISO-8601 and we normalise via `datetime(?)`.
--
-- The schedule is keyed on the *feature* (the conversation), not a session: a
-- brand-new conversation has no agent_sessions row yet, so keying on the feature
-- lets users schedule the very first message. At dispatch time the scheduler
-- resolves (or creates) the feature's session and delivers into it.
CREATE TABLE scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
);

-- Drives the scheduler's "what's due now" scan.
CREATE INDEX idx_scheduled_messages_due ON scheduled_messages(status, scheduled_at);

-- Enforce the product rule: at most one *pending* scheduled message per
-- conversation. Sent/failed rows are unconstrained so history (and
-- re-scheduling) still works.
CREATE UNIQUE INDEX idx_scheduled_messages_one_pending_per_feature
    ON scheduled_messages(feature_id)
    WHERE status = 'pending';
