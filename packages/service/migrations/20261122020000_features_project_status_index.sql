-- Speed up per-project feature listing (`list_by_project`, `list_ids_by_project`)
-- and guarantee the covering index for per-feature latest-user-message lookups.
CREATE INDEX IF NOT EXISTS idx_features_project_status
ON features(project_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_role_created
ON agent_messages(session_id, role, created_at);
