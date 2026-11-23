-- One queue per session for everything waiting for the end of its turn: the
-- user's own prompts (composer ⌘Enter) and the messages other sessions' agents
-- send with `delivery=next_turn`. `origin_kind` says which; an agent message
-- keeps its sender and, in `original_content`, the text the sender sent, so a
-- retransmission can be matched after the user edited it.
ALTER TABLE agent_session_prompt_queue ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'user'
    CHECK (origin_kind IN ('user', 'session'));
ALTER TABLE agent_session_prompt_queue ADD COLUMN source_session_id INTEGER
    REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_session_prompt_queue ADD COLUMN original_content TEXT;
ALTER TABLE agent_session_prompt_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

-- The sweep looks for sessions with agent messages to deliver; history stays
-- out of that scan. Deleting a sender nulls its messages' `source_session_id`.
CREATE INDEX idx_prompt_queue_pending_agent_messages
ON agent_session_prompt_queue(session_id)
WHERE status = 'pending' AND origin_kind = 'session';
CREATE INDEX idx_prompt_queue_source_session
ON agent_session_prompt_queue(source_session_id)
WHERE source_session_id IS NOT NULL;

-- Agent messages still waiting move over with their identity. A row claimed
-- by a process that died keeps `delivering`: startup recovery reports it as
-- failed, as it does for every queued message. Delivered, cancelled and
-- failed rows stay behind as history; the sender heard about each failure.
-- A row whose target is gone (written while foreign keys were off) has no
-- queue to join, and a sender that is gone has nothing to be attributed to.
INSERT INTO agent_session_prompt_queue
    (session_id, content, status, error, created_at, updated_at, source_message_uuid,
     message_uuid, origin_kind, source_session_id, original_content, attempt_count)
SELECT q.target_session_id, q.content, q.status, q.error, q.created_at, q.created_at,
       q.message_uuid, q.message_uuid, 'session', source.id, q.content, q.attempt_count
FROM agent_session_message_queue q
JOIN agent_sessions target ON target.id = q.target_session_id
LEFT JOIN agent_sessions source ON source.id = q.source_session_id
WHERE q.status IN ('pending', 'delivering')
ORDER BY q.id;

-- The old table is no longer read or written; nothing in it stays pending.
UPDATE agent_session_message_queue
SET status = 'cancelled', error = 'Moved to agent_session_prompt_queue.',
    claim_token = NULL, claimed_at = NULL
WHERE status IN ('pending', 'delivering');
