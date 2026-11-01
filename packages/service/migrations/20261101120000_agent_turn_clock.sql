-- The running turn's clock, owned by the live status book and written only on
-- its transitions (start, gate opened/answered, model reported, end), never on
-- a tick. A restarted service seeds the book from it, so a turn still waiting
-- on its user keeps its timer and a turn a restart cut off is still summarized.
ALTER TABLE agent_sessions ADD COLUMN turn_started_at_ms INTEGER;
-- Time the turn spent waiting on its user (question, permission) so far.
ALTER TABLE agent_sessions ADD COLUMN turn_waiting_ms INTEGER NOT NULL DEFAULT 0;
-- Set while a gate is open: when it opened.
ALTER TABLE agent_sessions ADD COLUMN turn_waiting_since_ms INTEGER;
-- JSON array of the models the CLI reported running the turn, in order.
ALTER TABLE agent_sessions ADD COLUMN turn_models TEXT;
-- Last model the CLI reported running the conversation's root agent: a later
-- report naming another one is a real model switch.
ALTER TABLE agent_sessions ADD COLUMN reported_model TEXT;
