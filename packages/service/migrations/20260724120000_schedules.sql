-- Unified schedules: one table for every "run this prompt later" rule.
--
-- Supersedes `scheduled_messages`, which could only queue a single one-shot
-- message per conversation. A schedule now carries three orthogonal choices:
--
--   * target     — an existing conversation, or a brand-new one created per run
--   * payload    — the prompt text (plus runtime options for new conversations)
--   * recurrence — once, every N seconds, or daily/weekly/monthly at a local time
--
-- Timing lives in two places on purpose. The *rule* (`recurrence_kind` and
-- friends, interpreted in `timezone`) is what the user edits; `next_run_at` is
-- the derived UTC instant the poll loop scans for. Storing the derived instant
-- keeps the "what's due" scan a single indexed comparison against
-- `datetime('now')`, exactly as the old table did, while the rule stays
-- editable and DST-correct (recomputed in the schedule's own timezone after
-- every run).
CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Optional user label. Falls back to the prompt's first line in the UI.
    name TEXT,
    prompt TEXT NOT NULL,

    -- 'conversation'     -> deliver into `feature_id`
    -- 'new_conversation' -> create a fresh conversation in `project_id` per run
    target_kind TEXT NOT NULL CHECK (target_kind IN ('conversation', 'new_conversation')),
    feature_id INTEGER REFERENCES features(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,

    -- New-conversation runtime options. All optional: NULL means "resolve the
    -- same defaults the New Session button would".
    title_template TEXT,
    provider TEXT,
    model TEXT,
    thinking_level TEXT,
    worktree_mode TEXT CHECK (worktree_mode IS NULL OR worktree_mode IN ('new', 'reuse', 'skip')),
    reuse_branch TEXT,
    base_branch TEXT,

    recurrence_kind TEXT NOT NULL CHECK (
        recurrence_kind IN ('once', 'interval', 'daily', 'weekly', 'monthly')
    ),
    -- kind = 'interval'
    interval_seconds INTEGER,
    -- kind = 'daily' | 'weekly' | 'monthly'; local wall-clock 'HH:MM'.
    time_of_day TEXT,
    -- kind = 'weekly'; CSV of ISO weekdays, 1 = Monday .. 7 = Sunday.
    weekdays TEXT,
    -- kind = 'monthly'; 1-31, clamped to the last day of shorter months.
    day_of_month INTEGER,
    -- IANA zone the wall-clock fields are interpreted in, so "daily at 09:00"
    -- survives DST transitions instead of drifting by an hour.
    timezone TEXT NOT NULL DEFAULT 'UTC',

    -- User intent. Pausing keeps the rule and its history; `next_run_at` is
    -- recomputed on resume so a paused schedule can't fire a stale backlog.
    enabled INTEGER NOT NULL DEFAULT 1,
    -- Derived UTC instant ('YYYY-MM-DD HH:MM:SS'). NULL once a 'once' schedule
    -- has fired — that, not `enabled`, is what marks a schedule finished.
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT CHECK (last_status IS NULL OR last_status IN ('sent', 'failed', 'skipped')),
    last_error TEXT,
    -- Conversation the most recent run landed in, so the UI can link to it.
    -- SET NULL (not CASCADE): deleting that conversation must not delete the rule.
    last_feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
    run_count INTEGER NOT NULL DEFAULT 0,

    -- Durable dispatch claim, mirroring the queue/scheduled-message barrier:
    -- a crash mid-dispatch leaves a claimed row that can be identified rather
    -- than a row that silently re-fires every tick.
    claim_token TEXT,
    claimed_at TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    -- Each target kind requires its own anchor; neither is optional.
    CHECK (
        (target_kind = 'conversation' AND feature_id IS NOT NULL)
        OR (target_kind = 'new_conversation' AND project_id IS NOT NULL)
    )
);

-- Drives the poll loop's "what's due now" scan.
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
-- Conversation and project views (composer card, per-project grouping).
CREATE INDEX idx_schedules_feature ON schedules(feature_id);
CREATE INDEX idx_schedules_project ON schedules(project_id);

-- Carry over live one-shot schedules. `pending` rows never fired; `dispatching`
-- rows were claimed by a process that died before marking a terminal state, so
-- they are also still owed. Sent/failed rows are history nothing reads.
--
-- The EXISTS guard is defensive: the old FK should have cascaded away orphans,
-- but a legacy database that ran without `foreign_keys = ON` could still hold
-- rows pointing at a deleted conversation, and those must not fail the insert.
INSERT INTO schedules (
    prompt, target_kind, feature_id, recurrence_kind, timezone,
    enabled, next_run_at, created_at, updated_at
)
SELECT
    sm.text, 'conversation', sm.feature_id, 'once', 'UTC',
    1, sm.scheduled_at, sm.created_at, sm.updated_at
FROM scheduled_messages sm
WHERE sm.status IN ('pending', 'dispatching')
  AND EXISTS (SELECT 1 FROM features f WHERE f.id = sm.feature_id);

DROP TABLE scheduled_messages;
