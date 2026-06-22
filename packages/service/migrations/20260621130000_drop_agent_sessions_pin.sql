-- Pinned conversations are now a feature-level concept (features.is_pinned,
-- migration 20260621120000). The sidebar "Pinned" section and the Unified
-- Agents grid share that single source of truth, so the older per-session pin
-- column on agent_sessions is removed.
DROP INDEX IF EXISTS idx_agent_sessions_is_pinned;
ALTER TABLE agent_sessions DROP COLUMN is_pinned;
