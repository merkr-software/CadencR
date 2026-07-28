use crate::domain::agents::adapter::{RuntimeTokenUsage, RuntimeTokenUsageEntry};

/// Claude's `result.modelUsage` is the authoritative per-model, per-turn
/// accounting. Older CLI versions can omit it, in which case the result-level
/// cumulative counter still lets the recorder persist an idempotent delta.
pub(super) fn claude_token_usage(
    msg: &claude_agent_sdk_rs::SdkMessage,
) -> Option<RuntimeTokenUsage> {
    let claude_agent_sdk_rs::SdkMessage::Result {
        uuid,
        usage,
        model_usage,
        ..
    } = msg
    else {
        return None;
    };
    let entries = model_usage
        .iter()
        .filter_map(|(model_id, usage)| {
            let input_tokens = usage.total_input_tokens();
            let output_tokens = usage.output_tokens;
            (input_tokens > 0 || output_tokens > 0).then(|| RuntimeTokenUsageEntry {
                model_id: Some(model_id.clone()),
                input_tokens,
                output_tokens,
            })
        })
        .collect::<Vec<_>>();
    if !entries.is_empty() {
        return Some(RuntimeTokenUsage::delta(Some(uuid.clone()), entries));
    }

    Some(RuntimeTokenUsage::cumulative(RuntimeTokenUsageEntry {
        model_id: None,
        input_tokens: usage.total_input_tokens(),
        output_tokens: usage.output_tokens,
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn result(model_usage: serde_json::Value) -> claude_agent_sdk_rs::SdkMessage {
        serde_json::from_value(json!({
            "type": "result",
            "subtype": "success",
            "uuid": "r",
            "session_id": "s",
            "duration_ms": 10,
            "duration_api_ms": 5,
            "is_error": false,
            "num_turns": 1,
            "result": "ok",
            "total_cost_usd": 0.0,
            "usage": {
                "input_tokens": 100,
                "output_tokens": 20,
                "cache_read_input_tokens": 30,
                "cache_creation_input_tokens": 5
            },
            "permission_denials": [],
            "modelUsage": model_usage
        }))
        .unwrap()
    }

    #[test]
    fn uses_typed_per_model_usage_and_result_uuid() {
        let usage = claude_token_usage(&result(json!({
            "claude-opus-4-7[1m]": {
                "inputTokens": 100,
                "outputTokens": 20,
                "cacheReadInputTokens": 30,
                "cacheCreationInputTokens": 5,
                "contextWindow": 1000000
            }
        })))
        .unwrap();
        let RuntimeTokenUsage::Delta { event_id, entries } = usage else {
            panic!("expected per-turn usage");
        };

        assert_eq!(event_id.as_deref(), Some("r"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].model_id.as_deref(), Some("claude-opus-4-7[1m]"));
        assert_eq!(
            (entries[0].input_tokens, entries[0].output_tokens),
            (135, 20)
        );
    }

    #[test]
    fn falls_back_to_cumulative_result_usage() {
        let usage = claude_token_usage(&result(json!({}))).unwrap();
        let RuntimeTokenUsage::Cumulative { entry } = usage else {
            panic!("expected cumulative usage");
        };

        assert_eq!((entry.input_tokens, entry.output_tokens), (135, 20));
    }
}
