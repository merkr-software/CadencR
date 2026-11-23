-- Conversations whose agent runtime still owes them a resume although no turn
-- is running: background commands, agents or monitors it started are still
-- running, or a wake-up it scheduled is not due yet. The runtime starts the
-- next turn on its own when that work settles, so a restart, which kills the
-- runtime and its work, would leave these conversations waiting forever. The
-- restart capture reads this table to resume them too.
CREATE TABLE IF NOT EXISTS agent_background_work (
    session_id INTEGER PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- What the restart cut off: 'turn' when a turn was running, 'background' when
-- the turn had ended but its background work had not.
ALTER TABLE restart_continuations
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn' CHECK (kind IN ('turn', 'background'));
