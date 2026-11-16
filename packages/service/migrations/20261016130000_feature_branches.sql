-- Every branch a conversation has worked on, not just the one it was created
-- with. `feature_settings.worktree_branch` / `feature_branch` still record the
-- provisioned branch; this table adds the branches discovered afterwards (the
-- agent switching or creating a branch, the user linking one by hand), each
-- with its own compare target and the last pull / merge request seen for it.
--
-- origin:
--   'provisioned' -> the branch the conversation was created on
--   'checked_out' -> seen checked out in the conversation's own worktree
--   'agent'       -> checked out during one of the conversation's agent turns
--   'manual'      -> linked by the user
--
-- unlinked_at hides a branch the user removed; automatic discovery never
-- brings it back, only an explicit manual link does.
--
-- No backfill: the provisioned branch is always read from feature_settings
-- (a row only appears once it carries a target or a pull request), and the
-- legacy feature-level `target_branch` setting stays the fallback target.
CREATE TABLE IF NOT EXISTS feature_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('provisioned', 'checked_out', 'agent', 'manual')),
    target_branch TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    unlinked_at TEXT,
    pr_number INTEGER,
    pr_state TEXT,
    UNIQUE (feature_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_feature_branches_feature ON feature_branches(feature_id);

