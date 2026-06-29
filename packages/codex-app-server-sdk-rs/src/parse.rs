use serde_json::Value;

use crate::error::SdkError;
use crate::types::{CodexModel, ThreadHandle, ThreadSnapshot, ThreadTurn, TurnHandle};

pub(crate) fn parse_model(value: &Value) -> Option<CodexModel> {
    let id = value.get("id").and_then(Value::as_str)?.to_string();
    let supported_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("reasoningEffort").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    Some(CodexModel {
        id,
        label: value
            .get("displayName")
            .and_then(Value::as_str)
            .or_else(|| value.get("model").and_then(Value::as_str))
            .unwrap_or("Codex model")
            .to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        supported_efforts,
        default_effort: value
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        context_window: None,
        is_default: value
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub(crate) fn parse_thread_handle(result: &Value) -> Result<ThreadHandle, SdkError> {
    let id = result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or_else(|| result.get("threadId").and_then(Value::as_str))
        .ok_or_else(|| SdkError::Protocol("thread response missing id".to_string()))?;
    Ok(ThreadHandle { id: id.to_string() })
}

pub(crate) fn parse_thread_snapshot(result: &Value) -> Result<ThreadSnapshot, SdkError> {
    let thread = result
        .get("thread")
        .ok_or_else(|| SdkError::Protocol("thread response missing thread".to_string()))?;
    let id = thread
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::Protocol("thread response missing id".to_string()))?;
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(parse_thread_turn)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ThreadSnapshot {
        id: id.to_string(),
        turns,
    })
}

fn parse_thread_turn(value: &Value) -> Result<ThreadTurn, SdkError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::Protocol("thread turn missing id".to_string()))?;
    let user_message_count = value
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
        .count();
    Ok(ThreadTurn::new(id.to_string(), user_message_count))
}

pub(crate) fn parse_turn_handle(result: &Value) -> Result<TurnHandle, SdkError> {
    let turn = result
        .get("turn")
        .ok_or_else(|| SdkError::Protocol("turn response missing turn".to_string()))?;
    let id = turn
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::Protocol("turn response missing id".to_string()))?;
    Ok(TurnHandle {
        id: id.to_string(),
        status: turn
            .get("status")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{parse_model, parse_thread_handle, parse_thread_snapshot, parse_turn_handle};

    #[test]
    fn parses_model_thread_and_turn_handles() {
        let model = parse_model(&json!({
            "id": "gpt-5.4",
            "displayName": "GPT-5.4",
            "defaultReasoningEffort": "high",
            "supportedReasoningEfforts": [
                { "reasoningEffort": "low" },
                { "reasoningEffort": "high" },
                { "reasoningEffort": "max" }
            ],
            "isDefault": true
        }))
        .expect("model");
        let thread = parse_thread_handle(&json!({ "thread": { "id": "thread_1" } })).unwrap();
        let turn = parse_turn_handle(&json!({ "turn": { "id": "turn_1" } })).unwrap();

        assert_eq!(model.supported_efforts, vec!["low", "high", "max"]);
        assert_eq!(model.default_effort.as_deref(), Some("high"));
        assert!(model.is_default);
        assert_eq!(thread.id, "thread_1");
        assert_eq!(turn.id, "turn_1");
    }

    #[test]
    fn parses_thread_id_fallback_and_model_label_fallback() {
        let model = parse_model(&json!({
            "id": "codex-mini",
            "model": "Codex Mini"
        }))
        .expect("model");
        let thread = parse_thread_handle(&json!({ "threadId": "thread_fallback" })).unwrap();

        assert_eq!(model.label, "Codex Mini");
        assert!(model.supported_efforts.is_empty());
        assert_eq!(thread.id, "thread_fallback");
    }

    #[test]
    fn parses_thread_snapshots_with_user_message_counts() {
        let snapshot = parse_thread_snapshot(&json!({
            "thread": {
                "id": "thread_1",
                "turns": [
                    {
                        "id": "turn_1",
                        "status": "completed",
                        "items": [
                            { "type": "userMessage", "id": "u1", "content": [] },
                            { "type": "agentMessage", "id": "a1", "text": "ok" }
                        ]
                    },
                    {
                        "id": "turn_2",
                        "status": "completed",
                        "items": [
                            { "type": "userMessage", "id": "u2", "content": [] },
                            { "type": "userMessage", "id": "u3", "content": [] }
                        ]
                    }
                ]
            }
        }))
        .expect("snapshot");

        assert_eq!(snapshot.id, "thread_1");
        assert_eq!(snapshot.turns[0].user_message_count(), 1);
        assert_eq!(snapshot.turns[1].user_message_count(), 2);
    }

    #[test]
    fn parse_handles_reject_missing_ids() {
        assert!(parse_thread_handle(&json!({ "thread": {} })).is_err());
        assert!(parse_thread_snapshot(&json!({ "thread": {} })).is_err());
        assert!(parse_turn_handle(&json!({ "turn": {} })).is_err());
        assert!(parse_turn_handle(&json!({})).is_err());
    }
}
