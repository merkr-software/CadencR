-- Agent turns a service restart (app update, local rebuild, crash) cut off,
-- and what the next start did about each one. Rows are captured when the
-- service stops (or, after a crash, when it starts again) and resolved by the
-- startup pass that resumes the conversations.
CREATE TABLE IF NOT EXISTS restart_continuations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    cause TEXT NOT NULL CHECK (cause IN ('shutdown', 'crash')),
    -- What the user wanted for the turn: 'stop' when they quit Cadencr and
    -- chose to stop their agents, 'resume' for every other stop.
    intent TEXT NOT NULL DEFAULT 'resume' CHECK (intent IN ('resume', 'stop')),
    -- Version of the service that was running when the turn was cut off.
    app_version TEXT,
    captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'resumed', 'skipped', 'failed')
    ),
    reason TEXT,
    -- The "interrupted by a restart" transcript marker, written once. Only a
    -- written-once flag, so deliberately not a foreign key.
    marker_message_id INTEGER,
    resolved_at TEXT
);

-- One open continuation per conversation: a shutdown capture and the crash
-- capture of the next start may both see the same running session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restart_continuations_pending_session
    ON restart_continuations(session_id) WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_restart_continuations_session_resolved
    ON restart_continuations(session_id, resolved_at);
