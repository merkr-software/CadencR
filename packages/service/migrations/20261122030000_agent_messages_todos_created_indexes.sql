-- Partial index for per-session todo reconstruction (`latest_todos_sql`, `latest_todo_progress`)
-- and covering index for O(log N) per-session latest message timestamp lookups (`load_candidates`).
CREATE INDEX IF NOT EXISTS idx_agent_messages_session_todo_tools
ON agent_messages(session_id, id)
WHERE message_type = 'tool_call'
  AND tool_name IN ('TodoWrite', 'TaskCreate', 'TaskUpdate');

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_created
ON agent_messages(session_id, created_at DESC);
