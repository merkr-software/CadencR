-- The cleanup an archive asked for (kill terminals, close browser tabs, remove
-- the worktree, delete the branch), one row per step. Planned in the archive's
-- own transaction and updated as each step settles, so a cleanup cut short by
-- a crash or a restart is still known afterwards: its unsettled steps are
-- marked 'interrupted' at startup and can be resumed.
CREATE TABLE IF NOT EXISTS feature_archive_cleanup_steps (
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    step TEXT NOT NULL CHECK (step IN ('terminals', 'browser_tabs', 'worktree', 'branch')),
    -- Run order: terminals, browser tabs, worktree, branch.
    position INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'interrupted', 'done', 'skipped', 'blocked', 'failed')
    ),
    -- The user confirmed discarding what the step would otherwise refuse to
    -- (uncommitted changes, unmerged commits).
    force INTEGER NOT NULL DEFAULT 0,
    -- Not asked for, but required by another step (removing the branch takes
    -- its worktree first); dropped from the report when there was nothing to do.
    implied INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    message TEXT,
    detail TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (feature_id, step)
);

CREATE INDEX IF NOT EXISTS idx_feature_archive_cleanup_steps_status
    ON feature_archive_cleanup_steps (status);
