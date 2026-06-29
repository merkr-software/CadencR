-- Rewind & Fork support (Claude Code first; provider-neutral substrate).
--
-- Additive only: a new side table plus one nullable column + index. The hot
-- `agent_messages` insert path is untouched and no existing row is rewritten.

-- `turn_checkpoints` links a user message to the worktree snapshot taken
-- immediately BEFORE that turn ran (the "before message N" code state). The
-- `commit_sha` is an orphan commit kept alive under `refs/cadencr/checkpoints/*`.
-- ON DELETE CASCADE so a rewind that deletes `agent_messages` rows also drops
-- their checkpoints (requires `PRAGMA foreign_keys = ON`, which the app sets).
CREATE TABLE IF NOT EXISTS turn_checkpoints (
    message_id  INTEGER PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
    commit_sha  TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'pre_turn',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Map a Cadencr message row to the provider's own per-message id, so transcript
-- surgery (rewind/fork) can find the exact cut line. Provider-neutral by name:
-- Claude stores its per-message `uuid`; Codex/OpenCode store their own id.
ALTER TABLE agent_messages ADD COLUMN provider_message_uuid TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_messages_provider_uuid
    ON agent_messages(session_id, provider_message_uuid);
