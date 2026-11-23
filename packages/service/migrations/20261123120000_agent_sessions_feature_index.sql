-- Per-feature session lookups (sidebar activity order, latest-session join,
-- spawn links, unified agents candidates, todo progress) filter
-- `agent_sessions` by `feature_id`. Its only index was dropped with the legacy
-- workflow (`idx_agent_sessions_feature_status`), so each feature scanned every
-- session. `(feature_id, id)` also serves `ORDER BY id DESC LIMIT 1` for the
-- latest session without a sort.
CREATE INDEX IF NOT EXISTS idx_agent_sessions_feature_id
ON agent_sessions(feature_id, id);

-- `idx_agent_messages_session_id_desc(session_id, id DESC)` stores exactly the
-- same keys (`id` is the rowid), so this one only costs writes.
DROP INDEX IF EXISTS idx_agent_messages_session;
