-- Synthetic "heavy user" data for a perf baseline, applied to an isolated QA
-- run's database (never to ~/.cadencr/database, never to a copy holding real
-- schedules). Every session is completed with no runtime ids: nothing can be
-- resumed, spawned or scheduled.
--
--   sqlite3 "$QA_DB" < .agents/skills/perf/seed-large.sql
--
-- Scale: edit the numbers below. The defaults (3000 features, 6000 sessions,
-- 400k messages, ~450 MB) reproduced the 2026-11 sidebar regression in seconds.
-- Rows land in the run's first registered project, so the UI shows them.

CREATE TEMP TABLE seed_params AS SELECT
  3000 AS features,            -- one third active, the rest archived
  2    AS sessions_per_feature,
  66   AS messages_per_session, -- ~10% user, 60% text, 20% tool_call, 10% tool_result
  300  AS content_bytes;

CREATE TEMP TABLE seed_project AS
  SELECT id FROM projects WHERE kind = 'user' ORDER BY id LIMIT 1;

BEGIN;

INSERT INTO features (project_id, title, status, created_at)
WITH RECURSIVE n(i) AS (
  SELECT 1 UNION ALL SELECT i + 1 FROM n, seed_params WHERE i < seed_params.features
)
SELECT (SELECT id FROM seed_project),
       'perf seed ' || i,
       CASE WHEN i % 3 = 0 THEN 'active' ELSE 'archived' END,
       datetime('2026-01-01', '+' || i || ' minutes')
FROM n;

CREATE TEMP TABLE seed_features AS
  SELECT id FROM features WHERE title LIKE 'perf seed %';

INSERT INTO agent_sessions (feature_id, agent_type, status, started_at, permission_mode)
WITH RECURSIVE k(j) AS (
  SELECT 1 UNION ALL SELECT j + 1 FROM k, seed_params WHERE j < seed_params.sessions_per_feature
)
SELECT f.id, 'session', 'completed', datetime('2026-01-01', '+' || f.id || ' minutes'), 'default'
FROM seed_features f CROSS JOIN k;

INSERT INTO agent_messages (session_id, role, content, message_type, tool_name, tool_use_id, created_at)
WITH RECURSIVE m(x) AS (
  SELECT 0 UNION ALL SELECT x + 1 FROM m, seed_params WHERE x + 1 < seed_params.messages_per_session
)
SELECT s.id,
       CASE WHEN m.x % 10 = 0 THEN 'user' ELSE 'assistant' END,
       printf('%.*c', (SELECT content_bytes FROM seed_params), 'x'),
       CASE
         WHEN m.x % 10 = 0 THEN 'user_message'
         WHEN m.x % 10 IN (1, 2) THEN 'tool_call'
         WHEN m.x % 10 = 3 THEN 'tool_result'
         ELSE 'text'
       END,
       CASE WHEN m.x % 10 = 1 THEN 'Bash' WHEN m.x % 10 = 2 THEN 'TodoWrite' END,
       CASE WHEN m.x % 10 IN (1, 2, 3) THEN 'tu-' || s.id || '-' || (m.x / 10) || '-' || (m.x % 10 % 3) END,
       datetime('2026-01-01', '+' || s.id || ' minutes', '+' || m.x || ' seconds')
FROM agent_sessions s
JOIN seed_features f ON f.id = s.feature_id
CROSS JOIN m;

COMMIT;

-- No ANALYZE: the service never runs one, so a baseline must see the planner
-- users get (stats would hide an index the planner skips without them).
SELECT 'seeded', (SELECT count(*) FROM seed_features) AS features,
       (SELECT count(*) FROM agent_sessions WHERE feature_id IN seed_features) AS sessions,
       (SELECT count(*) FROM agent_messages WHERE session_id IN
          (SELECT id FROM agent_sessions WHERE feature_id IN seed_features)) AS messages;
