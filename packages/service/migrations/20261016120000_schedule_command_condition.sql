-- Command-gated schedules: "every 15 minutes, run `cargo test`; only when it
-- fails, send the prompt".
--
-- The recurrence keeps meaning *when to evaluate*; the condition decides
-- *whether* that evaluation delivers. A schedule without a condition behaves
-- exactly as before, so both columns are nullable.
ALTER TABLE schedules ADD COLUMN condition_command TEXT;
-- Seconds the command may run before the evaluation is abandoned. NULL means
-- the service default.
ALTER TABLE schedules ADD COLUMN condition_timeout_seconds INTEGER;

-- Outcome of the most recent evaluation, kept apart from `last_status` on
-- purpose: `last_*` describes the last *delivery*, and a passing check delivers
-- nothing — folding it into `last_status` would make "it ran fine at 09:00"
-- unreadable behind a wall of "nothing to do" rows.
--
-- `last_check_status` is unconstrained like the runtime pins: 'passed' |
-- 'triggered' | 'busy' | 'error' today, and a CHECK would turn the next value
-- into a table rebuild.
ALTER TABLE schedules ADD COLUMN last_check_at TEXT;
ALTER TABLE schedules ADD COLUMN last_check_status TEXT;
ALTER TABLE schedules ADD COLUMN last_check_exit_code INTEGER;
