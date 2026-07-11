CREATE TABLE IF NOT EXISTS agent_session_reply_waits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    responder_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    request_message_id INTEGER REFERENCES agent_messages(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spawn', 'message')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'armed', 'delivered', 'failed', 'cancelled')
    ),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    armed_at TEXT,
    delivered_at TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_session_reply_waits_responder_status
ON agent_session_reply_waits(responder_session_id, status);
