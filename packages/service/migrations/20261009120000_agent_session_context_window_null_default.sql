-- `agent_sessions.context_window` defaulted to 200000 since the baseline, so a
-- session whose provider had not reported a window yet read back as a confident
-- 200k — wrong for every natively-1M model. NULL is the "unknown" every reader
-- already handles, so new rows must start there.
--
-- SQLite cannot alter a column default in place. Swapping the column keeps the
-- table (and every FK into it) intact instead of rebuilding it; existing values
-- are carried over untouched, since a stored 200000 cannot be told apart from a
-- genuinely reported one.
ALTER TABLE agent_sessions ADD COLUMN context_window_next INTEGER;
UPDATE agent_sessions SET context_window_next = context_window;
ALTER TABLE agent_sessions DROP COLUMN context_window;
ALTER TABLE agent_sessions RENAME COLUMN context_window_next TO context_window;
