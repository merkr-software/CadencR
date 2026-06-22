use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use opencode_sdk_rs::parsing::parse_message_from;
use opencode_sdk_rs::types::{MessagePart, MessageRole, ModelRef};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

use super::types::{truncate_title, ImportedConversation, ImportedMessage};

pub async fn list_project_conversations(
    project_path: &str,
) -> Result<Vec<ImportedConversation>, AppError> {
    let mut out = Vec::new();
    for db_path in opencode_db_files()? {
        match list_project_conversations_in_db(&db_path, project_path).await {
            Ok(mut conversations) => out.append(&mut conversations),
            Err(err) => tracing::warn!(
                db = %db_path.display(),
                error = %err,
                "failed to inspect OpenCode database — skipping"
            ),
        }
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

pub async fn load_project_conversation_by_id(
    project_path: &str,
    source_session_id: &str,
) -> Result<Option<ImportedConversation>, AppError> {
    for db_path in opencode_db_files()? {
        let conversations = match list_project_conversations_in_db(&db_path, project_path).await {
            Ok(conversations) => conversations,
            Err(err) => {
                tracing::warn!(
                    db = %db_path.display(),
                    error = %err,
                    "failed to inspect OpenCode database — skipping"
                );
                continue;
            }
        };
        if let Some(conv) = conversations
            .into_iter()
            .find(|conv| conv.source_session_id == source_session_id)
        {
            return Ok(Some(conv));
        }
    }
    Ok(None)
}

pub async fn list_project_conversations_in_db(
    db_path: &Path,
    project_path: &str,
) -> Result<Vec<ImportedConversation>, AppError> {
    let pool = open_readonly_pool(db_path).await?;
    let sessions = sqlx::query(
        "SELECT id, title, model, time_created, time_updated
         FROM session
         WHERE directory = ? AND parent_id IS NULL",
    )
    .bind(project_path)
    .fetch_all(&pool)
    .await?;

    let mut out = Vec::with_capacity(sessions.len());
    for session in sessions {
        let source_session_id: String = session.try_get("id")?;
        let title: String = session.try_get("title")?;
        let model =
            opencode_session_model(session.try_get::<Option<String>, _>("model").ok().flatten());
        let started_at = int_timestamp_field(&session, "time_created");
        let modified_at = int_timestamp_field(&session, "time_updated").or(started_at.clone());
        let messages = load_session_messages(&pool, &source_session_id).await?;
        if messages.is_empty() {
            continue;
        }
        let title = if title.trim().is_empty() {
            derived_title(&messages, &source_session_id)
        } else {
            title
        };
        out.push(ImportedConversation {
            source_session_id,
            title,
            model,
            started_at,
            modified_at,
            messages,
        });
    }
    Ok(out)
}

fn opencode_session_model(raw: Option<String>) -> Option<String> {
    let model_ref = serde_json::from_str::<ModelRef>(raw.as_deref()?).ok()?;
    Some(format!("{}/{}", model_ref.provider_id, model_ref.model_id))
}

fn opencode_db_files() -> Result<Vec<PathBuf>, AppError> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let dir = home.join(".local").join("share").join("opencode");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(AppError::Internal(format!("read {}: {err}", dir.display()))),
    };
    Ok(entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("opencode") && name.ends_with(".db"))
        })
        .collect())
}

async fn open_readonly_pool(db_path: &Path) -> Result<SqlitePool, AppError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .foreign_keys(false)
        .busy_timeout(Duration::from_millis(5000))
        .pragma("query_only", "true");
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

async fn load_session_messages(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<ImportedMessage>, AppError> {
    let rows = sqlx::query(
        "SELECT id, time_created, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC, id ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::new();
    for row in rows {
        let message_id: String = row.try_get("id")?;
        let data: String = row.try_get("data")?;
        let message_time = int_timestamp_field(&row, "time_created");
        let mut message_json: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
        ensure_object_field(&mut message_json, "id", json!(message_id));
        ensure_object_field(&mut message_json, "sessionID", json!(session_id));
        if let Some(ts) = message_time.clone() {
            ensure_object_field(&mut message_json, "created_at", json!(ts));
        }
        let parts = load_message_parts(pool, session_id, &message_id).await?;
        if !parts.is_empty() {
            ensure_object_field(&mut message_json, "parts", Value::Array(parts));
        }
        let Some(message) = parse_message_from(&message_json) else {
            continue;
        };
        for part in message.parts {
            if let Some(imported) = imported_message_from_part(
                &message.role,
                message.model.as_deref(),
                part,
                message.created_at.as_deref(),
            ) {
                out.push(imported);
            }
        }
    }
    Ok(out)
}

async fn load_message_parts(
    pool: &SqlitePool,
    session_id: &str,
    message_id: &str,
) -> Result<Vec<Value>, AppError> {
    let rows = sqlx::query(
        "SELECT data
         FROM part
         WHERE session_id = ? AND message_id = ?
         ORDER BY time_created ASC, id ASC",
    )
    .bind(session_id)
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("data").ok())
        .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
        .collect())
}

fn imported_message_from_part(
    role: &MessageRole,
    model: Option<&str>,
    part: MessagePart,
    created_at: Option<&str>,
) -> Option<ImportedMessage> {
    match part {
        MessagePart::Text { text, .. } => Some(ImportedMessage {
            role: role_name(role),
            content: text,
            message_type: "text".to_string(),
            tool_name: None,
            tool_use_id: None,
            model: model.map(ToOwned::to_owned),
            created_at: created_at.map(ToOwned::to_owned),
        }),
        MessagePart::Thinking { thinking, .. } => Some(ImportedMessage {
            role: "assistant".to_string(),
            content: thinking,
            message_type: "thinking".to_string(),
            tool_name: None,
            tool_use_id: None,
            model: model.map(ToOwned::to_owned),
            created_at: created_at.map(ToOwned::to_owned),
        }),
        MessagePart::ToolUse {
            tool_id,
            name,
            input,
            ..
        } => Some(ImportedMessage {
            role: "assistant".to_string(),
            content: serde_json::to_string(&input).unwrap_or_default(),
            message_type: "tool_call".to_string(),
            tool_name: Some(name),
            tool_use_id: Some(tool_id),
            model: model.map(ToOwned::to_owned),
            created_at: created_at.map(ToOwned::to_owned),
        }),
        MessagePart::ToolResult {
            tool_use_id,
            is_error,
            content,
            ..
        } => Some(ImportedMessage {
            role: "tool".to_string(),
            content: string_content(content),
            message_type: if is_error {
                "tool_error"
            } else {
                "tool_result"
            }
            .to_string(),
            tool_name: None,
            tool_use_id: Some(tool_use_id),
            model: None,
            created_at: created_at.map(ToOwned::to_owned),
        }),
        MessagePart::StepFinish { .. } | MessagePart::Other(_) => None,
    }
}

fn role_name(role: &MessageRole) -> String {
    match role {
        MessageRole::User => "user".to_string(),
        MessageRole::Assistant => "assistant".to_string(),
        MessageRole::System => "system".to_string(),
        MessageRole::Other(role) => role.clone(),
    }
}

fn ensure_object_field(value: &mut Value, key: &str, field: Value) {
    if let Some(object) = value.as_object_mut() {
        object.entry(key.to_string()).or_insert(field);
    }
}

fn string_content(value: Value) -> String {
    match value {
        Value::String(text) => text,
        other => serde_json::to_string(&other).unwrap_or_default(),
    }
}

fn int_timestamp_field(row: &sqlx::sqlite::SqliteRow, field: &str) -> Option<String> {
    let millis = row.try_get::<Option<i64>, _>(field).ok().flatten()?;
    DateTime::<Utc>::from_timestamp_millis(millis).map(|dt| dt.to_rfc3339())
}

fn derived_title(messages: &[ImportedMessage], source_session_id: &str) -> String {
    messages
        .iter()
        .find(|msg| msg.role == "user" && !msg.content.trim().is_empty())
        .map(|msg| truncate_title(&msg.content))
        .unwrap_or_else(|| {
            let prefix: String = source_session_id.chars().take(8).collect();
            format!("OpenCode session {prefix}")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn exec(pool: &SqlitePool, sql: &str) {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn list_project_conversations_reads_opencode_sqlite_messages_and_parts() {
        let db = tempfile::NamedTempFile::new().unwrap();
        let url = format!("sqlite://{}", db.path().display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();

        exec(
            &pool,
            r#"CREATE TABLE session (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL,
                title TEXT NOT NULL,
                parent_id TEXT,
                model TEXT,
                time_created INTEGER,
                time_updated INTEGER
            )"#,
        )
        .await;
        exec(
            &pool,
            r#"CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                data TEXT NOT NULL
            )"#,
        )
        .await;
        exec(
            &pool,
            r#"CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER,
                data TEXT NOT NULL
            )"#,
        )
        .await;

        exec(&pool, "INSERT INTO session (id, directory, title, model, time_created, time_updated) VALUES ('ses_1', '/repo', 'OpenCode title', '{\"providerID\":\"openai\",\"modelID\":\"gpt-5.3-codex\"}', 1770000000000, 1770000005000)").await;
        exec(&pool, "INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_1', 'ses_1', 1770000001000, '{\"role\":\"user\"}')").await;
        exec(&pool, "INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_2', 'ses_1', 1770000002000, '{\"role\":\"assistant\",\"providerID\":\"openai\",\"modelID\":\"gpt-5.3-codex\"}')").await;
        exec(&pool, "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('part_1', 'msg_1', 'ses_1', 1770000001000, '{\"id\":\"part_1\",\"type\":\"text\",\"text\":\"hello\"}')").await;
        exec(&pool, "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('part_2', 'msg_2', 'ses_1', 1770000002000, '{\"id\":\"part_2\",\"type\":\"tool\",\"tool\":\"bash\",\"callID\":\"call_1\",\"state\":{\"input\":{\"command\":\"ls\"},\"output\":\"ok\"}}')").await;
        drop(pool);

        let conversations = list_project_conversations_in_db(db.path(), "/repo")
            .await
            .unwrap();

        assert_eq!(conversations.len(), 1);
        let conv = &conversations[0];
        assert_eq!(
            (
                conv.source_session_id.as_str(),
                conv.title.as_str(),
                conv.model.as_deref()
            ),
            ("ses_1", "OpenCode title", Some("openai/gpt-5.3-codex"))
        );
        assert_eq!(
            (conv.messages.len(), conv.messages[0].content.as_str()),
            (2, "hello")
        );
        assert_eq!(conv.messages[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(
            conv.messages[1].model.as_deref(),
            Some("openai/gpt-5.3-codex")
        );
    }
}
