//! Per-turn `Result` envelope emission and `session/prompt` usage parsing.
//! Sibling of [`super::turn_lifecycle`]; split out so neither file exceeds
//! the 400-line ceiling once W4's tests land.

use serde_json::{json, Value};

use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeTokenUsage,
    RuntimeTokenUsageEntry, RuntimeUsage,
};

/// Build the visible prompt boundary and retain the native response details.
pub(super) fn turn_result(
    session_id: Option<String>,
    context_window: Option<u64>,
    context_usage: Option<RuntimeUsage>,
    stop_reason: &str,
    response: &Value,
) -> RuntimeEvent {
    let raw = json!({
        "type": "result",
        "session_id": session_id.as_deref(),
        "stop_reason": stop_reason,
        "transport": "acp",
        "usage": response.get("usage"),
    });
    let metadata = RuntimeEventMetadata {
        session_id,
        usage: context_usage,
        context_window,
        raw,
    };
    RuntimeEvent::new(metadata, RuntimeEventKind::Result)
}

/// A detached boundary has no prompt delivery or usage of its own.
pub(super) fn detached_result(session_id: &str) -> RuntimeEvent {
    RuntimeEvent::new(
        RuntimeEventMetadata {
            session_id: Some(session_id.to_string()),
            raw: json!({
                "type":"result", "transport":"acp", "source":"detached_reply",
                "session_id":session_id
            }),
            ..Default::default()
        },
        RuntimeEventKind::DetachedReplyEnded,
    )
}

/// Parse usage from a native ACP prompt response. An independently settled
/// response has its own identity even when several prompts share one visible
/// turn and a single assistant message. Serial ACP adapters retain their
/// existing history correlation.
pub(super) fn accounting_token_usage(
    response: &Value,
    response_id: Option<&str>,
) -> Option<RuntimeTokenUsage> {
    let usage = response.get("usage")?;
    let input = usage_field(usage, "inputTokens", "input_tokens");
    let cached_read = usage_field(usage, "cachedReadTokens", "cached_read_tokens");
    let cached_write = usage_field(usage, "cachedWriteTokens", "cached_write_tokens");
    let input_with_cache = input
        .saturating_add(cached_read)
        .saturating_add(cached_write);

    let (input_tokens, output_tokens) =
        match usage_field_optional(usage, "totalTokens", "total_tokens") {
            Some(total) if total > 0 => {
                let input_tokens = input_with_cache.min(total);
                (input_tokens, total - input_tokens)
            }
            _ => {
                (
                    input_with_cache,
                    usage_field(usage, "outputTokens", "output_tokens")
                        .saturating_add(usage_field(usage, "thoughtTokens", "thought_tokens")),
                )
            }
        };
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    let entries = vec![RuntimeTokenUsageEntry {
        model_id: None,
        input_tokens,
        output_tokens,
    }];
    Some(match response_id {
        Some(id) => RuntimeTokenUsage::response_delta(format!("acp-prompt/{id}"), entries),
        None => RuntimeTokenUsage::delta(None, entries),
    })
}

fn usage_field(usage: &Value, camel: &str, snake: &str) -> u64 {
    usage_field_optional(usage, camel, snake).unwrap_or(0)
}

fn usage_field_optional(usage: &Value, camel: &str, snake: &str) -> Option<u64> {
    usage
        .get(camel)
        .or_else(|| usage.get(snake))
        .and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::{accounting_token_usage, turn_result};
    use crate::domain::agents::adapter::RuntimeTokenUsage;
    use serde_json::json;

    #[test]
    fn turn_result_preserves_native_stop_reason() {
        let event = turn_result(
            Some("s-1".into()),
            Some(123_456),
            None,
            "end_turn",
            &json!({}),
        );
        assert!(event.is_result());
        assert_eq!(event.raw_json()["stop_reason"], "end_turn");
        assert_eq!(event.raw_json()["transport"], "acp");
    }

    #[test]
    fn turn_result_does_not_treat_prompt_response_usage_as_context_usage() {
        let response = json!({
            "usage": {
                "totalTokens": 10_669,
                "inputTokens": 10_653,
                "outputTokens": 3,
                "thoughtTokens": 13,
            }
        });
        let event = turn_result(
            Some("s-1".into()),
            Some(200_000),
            None,
            "end_turn",
            &response,
        )
        .with_token_usage(accounting_token_usage(&response, None));
        assert!(
            event.usage().is_none(),
            "session/prompt usage is per-turn accounting, not a context-budget snapshot",
        );
        assert_eq!(event.context_window(), Some(200_000));
        let tokens = event.token_usage().expect("end-turn token usage");
        let RuntimeTokenUsage::Delta {
            entries,
            event_id,
            correlate_provider_message,
            ..
        } = tokens
        else {
            panic!("expected per-turn usage");
        };
        assert!(event_id.is_none());
        assert!(*correlate_provider_message);
        assert_eq!(entries[0].input_tokens, 10_653);
        assert_eq!(entries[0].output_tokens, 16);
    }

    #[test]
    fn turn_result_can_attach_provider_usage_fallback() {
        let event = turn_result(
            Some("s-1".into()),
            Some(200_000),
            Some(crate::domain::agents::adapter::RuntimeUsage {
                input_tokens: 12_345,
                output_tokens: 0,
            }),
            "end_turn",
            &json!({}),
        );
        let usage = event.usage().expect("provider fallback usage is attached");
        assert_eq!(usage.input_tokens, 12_345);
        assert_eq!(usage.output_tokens, 0);
    }
}
