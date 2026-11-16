-- Count the prompts the user sends, next to the tokens they cost, in the same
-- per (UTC day, provider, model, effort) buckets. Like the token totals, the
-- counter is kept apart from conversations: deleting one keeps its count.
ALTER TABLE provider_usage_stats ADD COLUMN user_messages INTEGER NOT NULL DEFAULT 0;

-- Seed the counter from the conversations that still exist, so the chart does
-- not start empty. Best effort, by necessity:
--   * a prompt is what the message navigator lists (`sessions/prompt_index.rs`):
--     a top-level user message the user wrote or imported, not a sub-agent
--     brief nor a message another agent or the system generated;
--   * a fork copies its source's messages, uuid and timestamp included, so a
--     prompt is counted once, in the oldest row carrying it;
--   * user rows record no model, so a prompt is filed under its session's
--     current provider / model / effort;
--   * sessions without a provider have nothing to chart and are skipped.
-- From here on the service counts each prompt as it is sent.
WITH prompts AS (
    SELECT MIN(m.id) AS id
    FROM agent_messages m
    LEFT JOIN agent_message_origins o ON o.message_id = m.id
    WHERE m.message_type = 'user_message'
      AND m.parent_tool_use_id IS NULL
      AND (o.origin_kind IS NULL OR o.origin_kind IN ('human', 'imported'))
    GROUP BY COALESCE(m.message_uuid, m.created_at || char(0) || m.content)
)
INSERT INTO provider_usage_stats
    (day, provider_id, model_id, thinking_effort, user_messages, updated_at)
SELECT date(m.created_at),
       s.runtime_provider,
       COALESCE(s.model, ''),
       COALESCE(s.thinking_effort, ''),
       COUNT(*),
       datetime('now')
FROM prompts p
JOIN agent_messages m ON m.id = p.id
JOIN agent_sessions s ON s.id = m.session_id
WHERE date(m.created_at) IS NOT NULL
  AND COALESCE(s.runtime_provider, '') <> ''
GROUP BY 1, 2, 3, 4
ON CONFLICT(day, provider_id, model_id, thinking_effort) DO UPDATE SET
    user_messages = user_messages + excluded.user_messages;
