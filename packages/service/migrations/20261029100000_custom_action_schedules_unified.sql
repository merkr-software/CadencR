-- Custom-action schedules move into the unified `schedules` table, so they are
-- listed, paused, run and edited on the Schedules page with the same rules
-- (once / interval / daily / weekly / monthly) as prompt schedules.
--
-- Additive on purpose: `target_kind` has a CHECK that would need a table
-- rebuild to accept a new value. A custom-action schedule is stored as
--
--   target_kind      = 'conversation'  (the existing CHECK already requires
--                                       `feature_id` for this kind)
--   feature_id       = the conversation whose working copy the action runs in
--   custom_action_id = the action to run (non-NULL marks the row as an action
--                      schedule; the API reports it as kind `custom_action`)
--   prompt           = ''              (NOT NULL; an action sends no prompt)
--
-- Deleting the action deletes its schedules, as the old table's FK did.
ALTER TABLE schedules
    ADD COLUMN custom_action_id INTEGER REFERENCES custom_actions(id) ON DELETE CASCADE;

CREATE INDEX idx_schedules_custom_action ON schedules(custom_action_id);

-- Carry over every live per-(action, conversation) interval schedule. The old
-- table had no paused state worth keeping (disabling deleted the row), so only
-- `enabled = 1` rows move. Orphans — rows whose action or conversation is gone
-- from a database that ran without `foreign_keys = ON` — are left behind with
-- the table. The interval is floored at the unified scheduler's 60s minimum
-- (the old floor was 5s, which the new editor would refuse to save back), and
-- the first run lands one interval from now, as the old timer did on startup.
INSERT INTO schedules (
    prompt, target_kind, feature_id, custom_action_id,
    recurrence_kind, interval_seconds, timezone,
    enabled, next_run_at
)
SELECT
    '', 'conversation', cas.feature_id, cas.action_id,
    'interval', MAX(cas.interval_seconds, 60), 'UTC',
    1, datetime('now', '+' || MAX(cas.interval_seconds, 60) || ' seconds')
FROM custom_action_schedules cas
WHERE cas.enabled = 1
  AND EXISTS (SELECT 1 FROM custom_actions a WHERE a.id = cas.action_id)
  AND EXISTS (SELECT 1 FROM features f WHERE f.id = cas.feature_id);

DROP TABLE custom_action_schedules;
