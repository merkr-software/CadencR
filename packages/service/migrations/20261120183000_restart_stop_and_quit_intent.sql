-- When the user last stopped each conversation. A restart never resumes
-- background work recorded before (or as) the user stopped it: the Stop ended
-- whatever resume the agent was owed. Written with the deletion of that
-- conversation's `agent_background_work` row, before the runtime is stopped.
CREATE TABLE IF NOT EXISTS agent_user_stops (
    session_id INTEGER PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    stopped_at TEXT NOT NULL
);

-- What the desktop said the next start should do with the agents a quit
-- stops, kept until that start consumes it. Without it, a quit whose capture
-- failed would be read by the next start as a crash, and resumed. At most one
-- row; none means resume everything, as after a crash or an update.
CREATE TABLE IF NOT EXISTS restart_quit_intent (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    resume_turns INTEGER NOT NULL CHECK (resume_turns IN (0, 1)),
    resume_background_work INTEGER NOT NULL CHECK (resume_background_work IN (0, 1)),
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
