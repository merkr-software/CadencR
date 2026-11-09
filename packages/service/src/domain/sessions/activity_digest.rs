//! Lean, glanceable "what is this agent doing" digest — one entry per
//! requested feature: identity, the latest session's provider, its last
//! top-level tool call and the start of its last reply. Built for always-on
//! surfaces (the macOS notch island) that poll while agents run, so one
//! statement reads a handful of index-backed rows per feature instead of a
//! session state.
//!
//! Live status is deliberately absent: it has exactly one source, the
//! `session_status` WS stream. Callers pick the features from that stream.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, SqlitePool};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

use super::repository::preview_snippet;

/// Upper bound on features per request — the notch lists a handful at most.
pub const MAX_DIGEST_FEATURES: usize = 32;
const REPLY_MAX_CHARS: usize = 280;
const ARG_STRING_MAX_CHARS: usize = 240;
const ARG_ARRAY_MAX_ITEMS: usize = 8;
const RAW_ARGS_MAX_CHARS: usize = 400;

#[derive(Debug, Deserialize, IntoParams)]
pub struct ActivityDigestParams {
    /// Comma-separated feature ids (at most 32).
    pub feature_ids: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentDigestToolCall {
    /// Tool name exactly as the provider reported it.
    pub name: String,
    /// The tool input JSON with long strings and arrays clipped, so a file
    /// write's body never crosses the wire. Still valid JSON when the stored
    /// input was.
    pub args: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentActivityDigestEntry {
    pub feature_id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub feature_title: String,
    pub provider: Option<String>,
    pub last_tool: Option<AgentDigestToolCall>,
    /// Start of the agent's latest top-level text reply, whitespace-collapsed.
    pub last_reply: Option<String>,
    /// ISO-8601 UTC timestamp of the session's latest message.
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentActivityDigestResponse {
    pub entries: Vec<AgentActivityDigestEntry>,
}

#[derive(Debug, FromRow)]
struct DigestRow {
    feature_id: i64,
    project_id: i64,
    project_name: String,
    feature_title: String,
    provider: Option<String>,
    tool_name: Option<String>,
    tool_content: Option<String>,
    reply_content: Option<String>,
    last_activity_at: Option<String>,
}

pub fn parse_feature_ids(raw: &str) -> Result<Vec<i64>, AppError> {
    let mut ids = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let id: i64 = part
            .parse()
            .map_err(|_| AppError::BadRequest(format!("Invalid feature id: {part}")))?;
        if id <= 0 {
            return Err(AppError::BadRequest(format!("Invalid feature id: {part}")));
        }
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > MAX_DIGEST_FEATURES {
        return Err(AppError::BadRequest(format!(
            "At most {MAX_DIGEST_FEATURES} feature ids per request."
        )));
    }
    Ok(ids)
}

/// One statement for the whole batch: the latest conversation session per
/// feature, then its last top-level tool call, last non-empty top-level reply
/// and newest message, each an index-backed `(session_id, id DESC)` seek.
const DIGEST_SQL: &str = r#"
WITH ids AS (SELECT CAST(value AS INTEGER) AS id, key AS pos FROM json_each(?)),
latest AS (
    SELECT s.feature_id, MAX(s.id) AS session_id
    FROM agent_sessions s INNER JOIN ids ON ids.id = s.feature_id
    WHERE s.agent_type = 'session'
    GROUP BY s.feature_id
),
marks AS (
    SELECT l.feature_id, l.session_id,
        (SELECT m.id FROM agent_messages m
         WHERE m.session_id = l.session_id AND m.message_type = 'tool_call'
           AND m.tool_name IS NOT NULL AND m.parent_tool_use_id IS NULL
         ORDER BY m.id DESC LIMIT 1) AS tool_id,
        (SELECT m.id FROM agent_messages m
         WHERE m.session_id = l.session_id AND m.role = 'assistant'
           AND m.message_type = 'text' AND m.parent_tool_use_id IS NULL
           AND TRIM(m.content) <> ''
         ORDER BY m.id DESC LIMIT 1) AS reply_id,
        (SELECT m.created_at FROM agent_messages m
         WHERE m.session_id = l.session_id
         ORDER BY m.id DESC LIMIT 1) AS last_at
    FROM latest l
)
SELECT f.id AS feature_id, f.project_id, p.name AS project_name,
       f.title AS feature_title, s.runtime_provider AS provider,
       t.tool_name, t.content AS tool_content, r.content AS reply_content,
       strftime('%Y-%m-%dT%H:%M:%SZ', mk.last_at) AS last_activity_at
FROM ids
INNER JOIN features f ON f.id = ids.id
INNER JOIN projects p ON p.id = f.project_id
LEFT JOIN marks mk ON mk.feature_id = f.id
LEFT JOIN agent_sessions s ON s.id = mk.session_id
LEFT JOIN agent_messages t ON t.id = mk.tool_id
LEFT JOIN agent_messages r ON r.id = mk.reply_id
ORDER BY ids.pos"#;

/// Entries follow the request order. Unknown feature ids are skipped rather
/// than failing the batch: a feature deleted between the status event and
/// this read is not an error.
pub async fn load_activity_digest(
    pool: &SqlitePool,
    feature_ids: &[i64],
) -> Result<AgentActivityDigestResponse, AppError> {
    let ids = serde_json::to_string(feature_ids)
        .map_err(|e| AppError::internal(format!("Couldn't encode feature ids: {e}")))?;
    let rows: Vec<DigestRow> = sqlx::query_as(DIGEST_SQL).bind(ids).fetch_all(pool).await?;
    let entries = rows
        .into_iter()
        .map(|row| AgentActivityDigestEntry {
            feature_id: row.feature_id,
            project_id: row.project_id,
            project_name: row.project_name,
            feature_title: row.feature_title,
            provider: row.provider,
            last_tool: row.tool_name.map(|name| AgentDigestToolCall {
                name,
                args: compact_tool_args(row.tool_content.as_deref().unwrap_or_default()),
            }),
            last_reply: row
                .reply_content
                .map(|content| preview_snippet(&content, REPLY_MAX_CHARS)),
            last_activity_at: row.last_activity_at,
        })
        .collect();
    Ok(AgentActivityDigestResponse { entries })
}

/// Clip a tool input for display: JSON keeps its shape with every long string
/// and array shortened; anything else is clipped as plain text.
fn compact_tool_args(content: &str) -> String {
    match serde_json::from_str::<Value>(content) {
        Ok(value) => compact_value(value).to_string(),
        Err(_) => preview_snippet(content, RAW_ARGS_MAX_CHARS),
    }
}

fn compact_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(preview_snippet(&s, ARG_STRING_MAX_CHARS)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(ARG_ARRAY_MAX_ITEMS)
                .map(compact_value)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, compact_value(item)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        for ddl in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL)",
            "CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL, agent_type TEXT NOT NULL, runtime_provider TEXT)",
            "CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, message_type TEXT NOT NULL, tool_name TEXT, parent_tool_use_id TEXT, created_at TEXT)",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        pool
    }

    async fn exec(pool: &SqlitePool, sql: &'static str) {
        sqlx::query(sql).execute(pool).await.unwrap();
    }

    #[test]
    fn parse_feature_ids_dedupes_and_rejects_garbage() {
        assert_eq!(parse_feature_ids("3, 1,3,,").unwrap(), vec![3, 1]);
        assert!(parse_feature_ids("").unwrap().is_empty());
        assert!(parse_feature_ids("1,x").is_err());
        assert!(parse_feature_ids("0").is_err());
        let too_many: Vec<String> = (1..=33).map(|i| i.to_string()).collect();
        assert!(parse_feature_ids(&too_many.join(",")).is_err());
    }

    #[test]
    fn compact_tool_args_clips_long_strings_but_stays_json() {
        let input = serde_json::json!({
            "file_path": "/a/b.ts",
            "content": "x".repeat(10_000),
            "edits": (0..20).collect::<Vec<_>>(),
        })
        .to_string();
        let compacted = compact_tool_args(&input);
        let parsed: Value = serde_json::from_str(&compacted).unwrap();
        assert_eq!(parsed["file_path"], "/a/b.ts");
        assert_eq!(
            parsed["content"].as_str().unwrap().chars().count(),
            ARG_STRING_MAX_CHARS + 1
        );
        assert_eq!(
            parsed["edits"].as_array().unwrap().len(),
            ARG_ARRAY_MAX_ITEMS
        );
        assert_eq!(compact_tool_args("not json"), "not json");
    }

    #[tokio::test]
    async fn digest_reads_latest_session_tool_and_reply() {
        let pool = setup_pool().await;
        exec(&pool, "INSERT INTO projects VALUES (1, 'cadencr')").await;
        exec(
            &pool,
            "INSERT INTO features VALUES (7, 1, 'Notch island'), (8, 1, 'No agent yet'), \
             (9, 1, 'Other agent')",
        )
        .await;
        exec(
            &pool,
            "INSERT INTO agent_sessions VALUES (1, 7, 'session', 'codex_cli'), \
             (2, 7, 'session', 'claude_code'), (3, 7, 'auto_name', 'claude_code'), \
             (4, 9, 'session', 'opencode')",
        )
        .await;
        exec(
            &pool,
            r#"INSERT INTO agent_messages VALUES
               (1, 2, 'assistant', 'First   answer', 'text', NULL, NULL, '2026-10-11 10:00:00'),
               (2, 2, 'assistant', '{"command":"pnpm test"}', 'tool_call', 'Bash', NULL, '2026-10-11 10:00:01'),
               (3, 2, 'assistant', '{"file_path":"/x"}', 'tool_call', 'Read', 'toolu_parent', '2026-10-11 10:00:02'),
               (4, 2, 'assistant', 'nested reply', 'text', NULL, 'toolu_parent', '2026-10-11 10:00:03'),
               (5, 3, 'assistant', 'auto name', 'text', NULL, NULL, '2026-10-11 10:00:04'),
               (6, 4, 'assistant', 'Other reply', 'text', NULL, NULL, '2026-10-11 10:00:05')"#,
        )
        .await;

        let digest = load_activity_digest(&pool, &[8, 404, 7, 9]).await.unwrap();
        assert_eq!(digest.entries.len(), 3);

        // Request order, the unknown id skipped.
        let empty = &digest.entries[0];
        assert_eq!(empty.feature_id, 8);
        assert!(empty.provider.is_none() && empty.last_tool.is_none());

        let entry = &digest.entries[1];
        assert_eq!(entry.feature_title, "Notch island");
        assert_eq!(entry.project_name, "cadencr");
        assert_eq!(entry.provider.as_deref(), Some("claude_code"));
        let tool = entry.last_tool.as_ref().unwrap();
        assert_eq!(tool.name, "Bash");
        assert_eq!(tool.args, r#"{"command":"pnpm test"}"#);
        assert_eq!(entry.last_reply.as_deref(), Some("First answer"));
        assert_eq!(
            entry.last_activity_at.as_deref(),
            Some("2026-10-11T10:00:03Z")
        );

        // Each feature reads only its own session.
        let other = &digest.entries[2];
        assert_eq!(other.provider.as_deref(), Some("opencode"));
        assert_eq!(other.last_reply.as_deref(), Some("Other reply"));
        assert!(other.last_tool.is_none());
    }
}
