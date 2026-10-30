-- Sub-agents a conversation's agent delegated work to, keyed by the dispatch
-- tool call (the "carrier") that launched each one. Provider adapters and the
-- stream reader merge what they learn into one row: the configuration at
-- launch, the model it actually ran on, and its status. The row is the source
-- of truth for a sub-agent's status; the transcript keeps its actions.
CREATE TABLE IF NOT EXISTS agent_subagent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    tool_use_id TEXT NOT NULL,
    parent_tool_use_id TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK (
        status IN ('running', 'completed', 'failed', 'stopped')
    ),
    status_reason TEXT,
    agent_type TEXT,
    agent_name TEXT,
    description TEXT,
    prompt TEXT,
    model TEXT,
    -- 1 when `model` is what the sub-agent ran on, 0 when it is the requested alias.
    model_resolved INTEGER NOT NULL DEFAULT 0,
    reasoning_effort TEXT,
    background INTEGER NOT NULL DEFAULT 0,
    child_session_id TEXT,
    duration_ms INTEGER,
    total_tokens INTEGER,
    tool_use_count INTEGER,
    result_summary TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, tool_use_id)
);

-- The feature's sub-agent list (looked up per carrier by the transcript's
-- sub-agent cards) finds the feature's carriers, then counts each one's actions.
CREATE INDEX IF NOT EXISTS idx_agent_messages_subagent_carriers
ON agent_messages(session_id, id)
WHERE message_type = 'tool_call' AND tool_name IN ('Task', 'Agent');

-- Covers the per-carrier action count and last activity: transcript rows keep
-- their columns after `content`, which a table lookup would read through.
CREATE INDEX IF NOT EXISTS idx_agent_messages_session_parent_tool
ON agent_messages(session_id, parent_tool_use_id, message_type, created_at)
WHERE parent_tool_use_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_tool_use
ON agent_messages(session_id, tool_use_id)
WHERE tool_use_id IS NOT NULL;
