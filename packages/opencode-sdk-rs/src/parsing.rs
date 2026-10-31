mod helpers;
mod part_parsing;

use serde_json::Value;

use self::helpers::{maybe_string, maybe_timestamp, nested_object, parse_session_status};
pub use self::part_parsing::parse_part_from;
use crate::types::{Message, MessagePart, MessageRole, Session, TokenCacheUsage, TokenUsage};

pub fn parse_session_from(payload: &Value) -> Option<Session> {
    let candidate = nested_object(payload, &["session", "info"]).unwrap_or(payload);
    let id = maybe_string(candidate, &["id", "session_id", "sessionID"])
        .or_else(|| maybe_string(payload, &["session_id", "sessionID"]))?;

    Some(Session {
        id,
        title: maybe_string(candidate, &["title"]),
        directory: maybe_string(candidate, &["directory", "cwd"]).unwrap_or_default(),
        status: parse_session_status(candidate),
        parent_id: maybe_string(candidate, &["parent_id", "parentID"]),
        created_at: maybe_timestamp(
            candidate,
            &["created_at", "createdAt"],
            &["time", "created"],
        ),
        updated_at: maybe_timestamp(
            candidate,
            &["updated_at", "updatedAt"],
            &["time", "updated"],
        ),
    })
}

pub fn parse_message_from(payload: &Value) -> Option<Message> {
    let candidate = nested_object(payload, &["message", "info"]).unwrap_or(payload);
    let id = maybe_string(candidate, &["id"])?;
    let session_id = maybe_string(candidate, &["session_id", "sessionID"])
        .or_else(|| maybe_string(payload, &["session_id", "sessionID"]))?;
    let role = MessageRole::from_str(&maybe_string(candidate, &["role"]).unwrap_or_default());
    let parts = payload
        .get("parts")
        .and_then(Value::as_array)
        .or_else(|| candidate.get("parts").and_then(Value::as_array))
        .map(|items| {
            items
                .iter()
                .map(parse_part_from)
                .collect::<Vec<MessagePart>>()
        })
        .or_else(|| {
            candidate
                .get("content")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(parse_part_from)
                        .collect::<Vec<MessagePart>>()
                })
        })
        .or_else(|| {
            candidate
                .get("content")
                .and_then(Value::as_str)
                .map(|text| {
                    vec![MessagePart::Text {
                        id: format!("{id}-text"),
                        text: text.to_string(),
                    }]
                })
        })
        .unwrap_or_default();

    let tokens = parse_token_usage(candidate);

    Some(Message {
        id,
        session_id,
        role,
        parts,
        created_at: maybe_timestamp(
            candidate,
            &["created_at", "createdAt"],
            &["time", "created"],
        ),
        model: maybe_model(candidate),
        tokens,
        finished: message_finished(candidate),
        completed_at: maybe_timestamp(candidate, &["completed_at"], &["time", "completed"]),
        finish: maybe_string(candidate, &["finish"]),
        error: message_error(candidate),
        error_name: candidate
            .get("error")
            .and_then(|error| error.get("name"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        variant: maybe_string(candidate, &["variant"]),
    })
}

/// OpenCode `MessageV2.Assistant.error`: a `NamedError` (`{name, data}`).
fn message_error(value: &Value) -> Option<String> {
    let error = value.get("error").filter(|error| !error.is_null())?;
    error
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .or_else(|| error.get("name").and_then(Value::as_str))
        .or_else(|| error.as_str())
        .map(ToOwned::to_owned)
}

fn maybe_model(value: &Value) -> Option<String> {
    if let Some(model) = maybe_string(value, &["model"]) {
        return Some(model);
    }
    let provider = maybe_string(value, &["providerID", "provider_id", "providerId"])?;
    let model = maybe_string(value, &["modelID", "model_id", "modelId"])?;
    Some(format!("{provider}/{model}"))
}

fn parse_token_usage(value: &Value) -> Option<TokenUsage> {
    let tokens = value.get("tokens")?;
    let cache = tokens.get("cache");
    let usage = TokenUsage {
        total: maybe_u64(tokens.get("total")),
        input: maybe_u64(tokens.get("input")).unwrap_or(0),
        output: maybe_u64(tokens.get("output")).unwrap_or(0),
        reasoning: maybe_u64(tokens.get("reasoning")).unwrap_or(0),
        cache: TokenCacheUsage {
            read: cache
                .and_then(|item| maybe_u64(item.get("read")))
                .unwrap_or(0),
            write: cache
                .and_then(|item| maybe_u64(item.get("write")))
                .unwrap_or(0),
        },
    };
    // Zero-token payloads mean "no usage data yet" — filter them out so
    // downstream code never overwrites real usage with zeros.
    if usage.is_zero() {
        None
    } else {
        Some(usage)
    }
}

fn maybe_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
}

fn message_finished(value: &Value) -> bool {
    maybe_string(value, &["finish"]).is_some()
        || value
            .get("time")
            .and_then(|time| time.get("completed"))
            .is_some()
}

#[cfg(test)]
mod tests {
    use super::parse_message_from;
    use serde_json::json;

    #[test]
    fn parse_message_from_supports_official_message_wrapper() {
        let message = parse_message_from(&json!({
            "info": {
                "id": "msg_1",
                "sessionID": "ses_1",
                "role": "assistant",
                "providerID": "openai",
                "modelID": "gpt-5.3-codex",
                "tokens": {
                    "total": 37,
                    "input": 20,
                    "output": 10,
                    "reasoning": 5,
                    "cache": { "read": 1, "write": 1 }
                },
                "time": { "created": 123 }
            },
            "parts": [
                { "id": "prt_1", "type": "reasoning", "text": "thinking" },
                { "id": "prt_2", "type": "text", "text": "OK" }
            ]
        }))
        .unwrap();

        assert_eq!(message.id, "msg_1");
        assert_eq!(message.session_id, "ses_1");
        assert_eq!(message.parts.len(), 2);
        assert_eq!(message.created_at.as_deref(), Some("123"));
        assert_eq!(message.model.as_deref(), Some("openai/gpt-5.3-codex"));
        let tokens = message.tokens.expect("expected token usage");
        assert_eq!(tokens.total, Some(37));
        assert_eq!(tokens.input, 20);
        assert_eq!(tokens.output, 10);
        assert_eq!(tokens.reasoning, 5);
        assert_eq!(tokens.cache.read, 1);
        assert_eq!(tokens.cache.write, 1);
        assert_eq!(tokens.total_input(), 22);
        assert!(!message.finished);
    }

    #[test]
    fn parse_message_from_marks_finished_messages() {
        let message = parse_message_from(&json!({
            "info": {
                "id": "msg_1",
                "sessionID": "ses_1",
                "role": "assistant",
                "providerID": "openai",
                "modelID": "gpt-5.3-codex",
                "finish": "stop",
                "time": { "created": 123, "completed": 456 }
            }
        }))
        .unwrap();

        assert!(message.finished);
        assert_eq!(message.completed_at.as_deref(), Some("456"));
        assert_eq!(message.finish.as_deref(), Some("stop"));
        assert_eq!(message.error, None);
    }

    #[test]
    fn parse_message_from_reads_variant_and_named_error() {
        // `MessageV2.Assistant` with an `APIError` NamedError (opencode 1.19).
        let message = parse_message_from(&json!({
            "info": {
                "id": "msg_2",
                "sessionID": "ses_child",
                "role": "assistant",
                "providerID": "anthropic",
                "modelID": "claude-haiku-5-5",
                "variant": "high",
                "error": { "name": "APIError", "data": { "message": "rate limited", "isRetryable": false } },
                "time": { "created": 10, "completed": 20 }
            }
        }))
        .unwrap();
        assert_eq!(message.variant.as_deref(), Some("high"));
        assert_eq!(message.error.as_deref(), Some("rate limited"));
        assert_eq!(message.error_name.as_deref(), Some("APIError"));
        assert_eq!(message.finish, None);
        let aborted = parse_message_from(&json!({
            "id": "msg_3", "sessionID": "ses_child", "role": "assistant",
            "error": { "name": "MessageAbortedError", "data": {} }
        }))
        .unwrap();
        assert_eq!(aborted.error.as_deref(), Some("MessageAbortedError"));
    }

    #[test]
    fn cache_only_tokens_are_preserved() {
        let message = parse_message_from(&json!({
            "id": "msg_1", "sessionID": "ses_1", "role": "assistant",
            "tokens": { "input": 0, "output": 0, "cache": { "read": 100 } }
        }))
        .unwrap();
        let tokens = message
            .tokens
            .expect("cache-only tokens should be preserved");
        assert_eq!(tokens.cache.read, 100);
    }
}
