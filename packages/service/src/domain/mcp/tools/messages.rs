use serde_json::json;
use sqlx::FromRow;

pub const DEFAULT_MAX_RETURNED_MESSAGE_CHARS: usize = 100_000;

#[derive(FromRow)]
pub struct MessageRow {
    pub id: i64,
    pub role: String,
    pub message_type: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub created_at: String,
    pub origin_kind: Option<String>,
    pub source_session_id: Option<i64>,
    pub source_feature_id: Option<i64>,
    pub source_project_id: Option<i64>,
    pub source_message_id: Option<i64>,
    pub origin_note: Option<String>,
    pub origin_created_at: Option<String>,
}

pub fn cap_message_content(
    mut messages: Vec<MessageRow>,
    max_chars: usize,
) -> (Vec<MessageRow>, usize, bool) {
    let mut remaining = max_chars;
    let mut returned = 0;
    let mut truncated = false;
    for message in &mut messages {
        let original_len = message.content.chars().count();
        let allowed = remaining.min(original_len);
        if allowed < original_len {
            message.content = message.content.chars().take(allowed).collect();
            truncated = true;
        }
        remaining -= allowed;
        returned += allowed;
    }
    (messages, returned, truncated)
}

pub fn fts_literal_query(query: &str) -> Option<String> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    Some(format!("\"{}\"", query.replace('"', "\"\"")))
}

pub fn messages_json(
    messages: &[MessageRow],
    include_metadata: bool,
    include_tool_details: bool,
) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|message| message_json(message, include_metadata, include_tool_details))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::fts_literal_query;

    #[test]
    fn fts_literal_query_quotes_special_syntax() {
        assert_eq!(
            fts_literal_query(r#"foo "bar" OR baz*"#).as_deref(),
            Some(r#""foo ""bar"" OR baz*""#)
        );
    }
}

fn message_json(
    message: &MessageRow,
    include_metadata: bool,
    include_tool_details: bool,
) -> serde_json::Value {
    let omit_content = !include_tool_details && is_tool_detail_message(message);
    let mut value = json!({
        "id": message.id,
        "role": message.role,
        "message_type": message.message_type,
        "content": if omit_content { serde_json::Value::Null } else { json!(message.content) },
        "content_omitted": omit_content,
        "tool_name": message.tool_name,
        "created_at": message.created_at
    });
    if include_metadata {
        value["origin"] = origin_json(message);
    }
    value
}

fn is_tool_detail_message(message: &MessageRow) -> bool {
    message.role == "tool" || matches!(message.message_type.as_str(), "tool_call" | "tool_result")
}

fn origin_json(message: &MessageRow) -> serde_json::Value {
    match message.origin_kind.as_deref() {
        Some(origin_kind) => json!({
            "origin_kind": origin_kind,
            "source_session_id": message.source_session_id,
            "source_feature_id": message.source_feature_id,
            "source_project_id": message.source_project_id,
            "source_message_id": message.source_message_id,
            "note": message.origin_note,
            "created_at": message.origin_created_at
        }),
        None => serde_json::Value::Null,
    }
}
