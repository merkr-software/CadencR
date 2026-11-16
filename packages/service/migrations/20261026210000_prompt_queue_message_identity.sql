-- Preserve the identity of prompt.send requests deferred during compaction.
-- Editing a queued message changes its delivery identity, while retransmitting
-- the original request must still refer to the same accepted queue entry.
ALTER TABLE agent_session_prompt_queue ADD COLUMN source_message_uuid TEXT;
ALTER TABLE agent_session_prompt_queue ADD COLUMN message_uuid TEXT;

CREATE UNIQUE INDEX idx_prompt_queue_source_message
ON agent_session_prompt_queue(session_id, source_message_uuid);
