-- Prompts the user queued for after the agent's current turn (composer ⌘Enter
-- while the agent works). Delivered one per finished turn, oldest first, as an
-- ordinary user message; editable and cancellable until then. Kept apart from
-- `agent_session_message_queue`, which carries agent-to-agent MCP traffic with
-- its own origin metadata and failure-notification contract.
CREATE TABLE IF NOT EXISTS agent_session_prompt_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'delivering', 'delivered', 'error', 'cancelled')
    ),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_session_prompt_queue_session_status
ON agent_session_prompt_queue(session_id, status, id);
