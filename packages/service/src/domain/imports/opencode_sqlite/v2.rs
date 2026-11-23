//! OpenCode 2.x conversations: `session_v2` and `session_message`.
//!
//! 2.x keeps the 1.x `session`/`message`/`part` tables after migrating their
//! history into its own, and writes new sessions only to its own tables. A
//! message row carries its whole content: `user` rows `{text, files}`,
//! `assistant` rows `{model: {id, providerID}, content: [...]}` whose items
//! are `text`, `reasoning` and `tool` (`{id, name, state: {status, input,
//! content, error}}`). With `experimental.part_rows` those items live in
//! `session_part` rows instead (ahead of any inline ones, by `ordinal`).

use std::collections::HashMap;

use serde_json::Value;
use sqlx::{Row, SqlitePool};

use super::{derived_title, int_timestamp_field};
use crate::domain::imports::types::{ImportedConversation, ImportedMessage};
use crate::error::AppError;

pub(super) async fn has_table(pool: &SqlitePool, table: &str) -> Result<bool, AppError> {
    let found = sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(table)
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

pub(super) async fn list_conversations(
    pool: &SqlitePool,
    project_path: &str,
) -> Result<Vec<ImportedConversation>, AppError> {
    let sessions = sqlx::query(
        "SELECT id, title, model, time_created, time_updated
         FROM session_v2
         WHERE directory = ? AND parent_id IS NULL",
    )
    .bind(project_path)
    .fetch_all(pool)
    .await?;
    let part_rows = has_table(pool, "session_part").await?;
    let mut out = Vec::with_capacity(sessions.len());
    for session in sessions {
        let source_session_id: String = session.try_get("id")?;
        let title: Option<String> = session.try_get("title")?;
        let model: Option<String> = session.try_get("model")?;
        let started_at = int_timestamp_field(&session, "time_created");
        let modified_at = int_timestamp_field(&session, "time_updated").or(started_at.clone());
        let messages = load_messages(pool, &source_session_id, part_rows).await?;
        if messages.is_empty() {
            continue;
        }
        let title = title
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| derived_title(&messages, &source_session_id));
        let model = model.and_then(|raw| session_model(&raw, &source_session_id));
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

async fn load_messages(
    pool: &SqlitePool,
    session_id: &str,
    part_rows: bool,
) -> Result<Vec<ImportedMessage>, AppError> {
    let rows = sqlx::query(
        "SELECT id, type, time_created, data
         FROM session_message
         WHERE session_id = ? AND type IN ('user', 'assistant')
         ORDER BY seq ASC, id ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut parts = if part_rows {
        load_parts(pool, session_id).await?
    } else {
        HashMap::new()
    };
    let mut out = Vec::new();
    for row in rows {
        let id: String = row.try_get("id")?;
        let kind: String = row.try_get("type")?;
        let raw: String = row.try_get("data")?;
        let created_at = int_timestamp_field(&row, "time_created");
        let Some(mut data) = parse_json(&raw, session_id) else {
            continue;
        };
        if let Some(mut items) = parts.remove(&id) {
            if let Some(Value::Array(inline)) = data.get_mut("content").map(Value::take) {
                items.extend(inline);
            }
            data["content"] = Value::Array(items);
        }
        out.extend(imported_messages(&kind, &data, created_at.as_deref()));
    }
    Ok(out)
}

/// A session's `session_part` items per message, in order.
async fn load_parts(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<HashMap<String, Vec<Value>>, AppError> {
    let rows = sqlx::query(
        "SELECT message_id, data FROM session_part
         WHERE session_id = ? ORDER BY message_id ASC, ordinal ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let mut parts: HashMap<String, Vec<Value>> = HashMap::new();
    for row in rows {
        let message_id: String = row.try_get("message_id")?;
        let raw: String = row.try_get("data")?;
        if let Some(part) = parse_json(&raw, session_id) {
            parts.entry(message_id).or_default().push(part);
        }
    }
    Ok(parts)
}

fn parse_json(raw: &str, session_id: &str) -> Option<Value> {
    match serde_json::from_str(raw) {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(%error, session_id, "skipping an unreadable OpenCode message");
            None
        }
    }
}

fn session_model(raw: &str, session_id: &str) -> Option<String> {
    model_ref(&parse_json(raw, session_id)?)
}

/// `{id, providerID}` → the `providerID/id` ref Cadencr and ACP use.
fn model_ref(model: &Value) -> Option<String> {
    let id = model.get("id")?.as_str()?;
    let provider = model.get("providerID")?.as_str()?;
    Some(format!("{provider}/{id}"))
}

fn imported_messages(kind: &str, data: &Value, created_at: Option<&str>) -> Vec<ImportedMessage> {
    let message = |role: &str, content: String, message_type: &str| ImportedMessage {
        role: role.to_string(),
        content,
        message_type: message_type.to_string(),
        tool_name: None,
        tool_use_id: None,
        model: data.get("model").and_then(model_ref),
        created_at: created_at.map(ToOwned::to_owned),
    };
    if kind == "user" {
        let text = data.get("text").and_then(Value::as_str).unwrap_or_default();
        return (!text.trim().is_empty())
            .then(|| message("user", text.to_string(), "text"))
            .into_iter()
            .collect();
    }
    let mut out = Vec::new();
    for item in data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
        match item.get("type").and_then(Value::as_str) {
            Some("text") if !text.trim().is_empty() => {
                out.push(message("assistant", text.to_string(), "text"));
            }
            Some("reasoning") if !text.trim().is_empty() => {
                out.push(message("assistant", text.to_string(), "thinking"));
            }
            Some("tool") => out.extend(tool_messages(item, &message)),
            _ => {}
        }
    }
    out
}

fn tool_messages(
    item: &Value,
    message: &dyn Fn(&str, String, &str) -> ImportedMessage,
) -> Vec<ImportedMessage> {
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .map(|name| opencode_sdk_rs::canonical_tool_name(name.to_owned()));
    let state = item.get("state").unwrap_or(&Value::Null);
    let input = state.get("input").unwrap_or(&Value::Null);
    let mut call = message("assistant", input.to_string(), "tool_call");
    call.tool_name = name.clone();
    call.tool_use_id = id.clone();
    let mut out = vec![call];
    let (content, message_type) = match state.get("status").and_then(Value::as_str) {
        Some("completed") => (output_text(state), "tool_result"),
        Some("error") => (
            state
                .get("error")
                .map(|error| match error {
                    Value::String(text) => text.clone(),
                    other => other
                        .get("message")
                        .and_then(Value::as_str)
                        .map_or_else(|| other.to_string(), ToOwned::to_owned),
                })
                .unwrap_or_default(),
            "tool_error",
        ),
        _ => return out,
    };
    let mut result = message("tool", content, message_type);
    result.tool_name = name;
    result.tool_use_id = id;
    out.push(result);
    out
}

fn output_text(state: &Value) -> String {
    state
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::imported_messages;
    use serde_json::json;

    #[test]
    fn user_text_and_assistant_items_become_imported_messages() {
        let user = imported_messages("user", &json!({ "text": "hello", "files": [] }), Some("t"));
        assert_eq!(user.len(), 1);
        assert_eq!(user[0].role, "user");
        assert_eq!(user[0].content, "hello");

        let assistant = imported_messages(
            "assistant",
            &json!({
                "model": { "id": "anthropic/claude-haiku-5.5", "providerID": "openrouter" },
                "content": [
                    { "type": "reasoning", "text": "thinking it over" },
                    { "type": "reasoning", "text": "" },
                    { "type": "tool", "id": "t1", "name": "shell", "state": {
                        "status": "completed", "input": { "command": "ls" },
                        "content": [{ "type": "text", "text": "README.md" }] } },
                    { "type": "tool", "id": "t2", "name": "read", "state": {
                        "status": "error", "input": {}, "error": { "message": "missing" } } },
                    { "type": "tool", "id": "t3", "name": "edit", "state": { "status": "running" } },
                    { "type": "text", "text": "done" }
                ]
            }),
            None,
        );
        let kinds: Vec<_> = assistant.iter().map(|m| m.message_type.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "thinking",
                "tool_call",
                "tool_result",
                "tool_call",
                "tool_error",
                "tool_call",
                "text"
            ]
        );
        assert_eq!(
            assistant[0].model.as_deref(),
            Some("openrouter/anthropic/claude-haiku-5.5")
        );
        assert_eq!(assistant[1].content, r#"{"command":"ls"}"#);
        assert_eq!(assistant[2].content, "README.md");
        assert_eq!(assistant[2].tool_use_id.as_deref(), Some("t1"));
        assert_eq!(assistant[1].tool_name.as_deref(), Some("Bash"));
        assert_eq!(assistant[4].content, "missing");
    }
}
