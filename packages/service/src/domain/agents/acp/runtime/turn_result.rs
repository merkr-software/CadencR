//! Per-turn `Result` envelope emission and `session/prompt` usage parsing.
//! Sibling of [`super::turn_lifecycle`]; split out so neither file exceeds
//! the 400-line ceiling once W4's tests land.

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeTokenUsage,
    RuntimeTokenUsageEntry, RuntimeUsage,
};

/// Forward a `RuntimeEventKind::Result` envelope to the message channel
/// when the agent reports a `stopReason`.
pub async fn emit_turn_result(
    tx: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    session_id: Option<String>,
    context_window: Option<u64>,
    usage: Option<RuntimeUsage>,
    stop_reason: &str,
    response: &Value,
) {
    let raw = json!({
        "type": "result",
        "session_id": session_id.clone(),
        "stop_reason": stop_reason,
        "transport": "acp",
        "usage": response.get("usage").cloned().unwrap_or(Value::Null),
    });
    let metadata = RuntimeEventMetadata {
        session_id,
        usage,
        context_window,
        raw,
    };
    let token_usage = accounting_token_usage(response);
    let event = RuntimeEvent::new(metadata, RuntimeEventKind::Result).with_token_usage(token_usage);
    if let Err(error) = tx.send(Ok(event)).await {
        tracing::debug!(%error, "failed to forward ACP turn result; channel closed");
    }
}

/// Parse the draft ACP end-turn usage shape. `totalTokens` is authoritative
/// when present: cache and thought categories differ across providers in
/// whether they overlap input/output, while the total always describes the
/// actual number the provider wants clients to report.
fn accounting_token_usage(response: &Value) -> Option<RuntimeTokenUsage> {
    let usage = response.get("usage")?;
    let input = usage_field(usage, "inputTokens", "input_tokens");
    let output = usage_field(usage, "outputTokens", "output_tokens");
    let thought = usage_field(usage, "thoughtTokens", "thought_tokens");
    let cached_read = usage_field(usage, "cachedReadTokens", "cached_read_tokens");
    let cached_write = usage_field(usage, "cachedWriteTokens", "cached_write_tokens");
    let input_with_cache = input
        .saturating_add(cached_read)
        .saturating_add(cached_write);

    let (input_tokens, output_tokens) =
        match usage_field_optional(usage, "totalTokens", "total_tokens") {
            Some(total) if total > 0 => {
                let input_tokens = input_with_cache.min(total);
                (input_tokens, total.saturating_sub(input_tokens))
            }
            _ => (input_with_cache, output.saturating_add(thought)),
        };
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    Some(RuntimeTokenUsage::delta(
        None,
        vec![RuntimeTokenUsageEntry {
            model_id: None,
            input_tokens,
            output_tokens,
        }],
    ))
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
    use super::emit_turn_result;
    use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeTokenUsage};
    use serde_json::json;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn emit_turn_result_sends_a_result_event() {
        let (tx, mut rx) = mpsc::channel(4);
        emit_turn_result(
            &tx,
            Some("s-1".into()),
            Some(123_456),
            None,
            "end_turn",
            &json!({}),
        )
        .await;
        let event = rx.recv().await.unwrap().unwrap();
        assert!(event.is_result());
        assert_eq!(event.raw_json()["stop_reason"], "end_turn");
        assert_eq!(event.raw_json()["transport"], "acp");
    }

    #[tokio::test]
    async fn emit_turn_result_silently_drops_when_channel_closed() {
        let (tx, rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
        drop(rx);
        emit_turn_result(&tx, None, None, None, "cancelled", &json!({})).await;
    }

    #[tokio::test]
    async fn emit_turn_result_does_not_treat_prompt_response_usage_as_context_usage() {
        let (tx, mut rx) = mpsc::channel(4);
        emit_turn_result(
            &tx,
            Some("s-1".into()),
            Some(200_000),
            None,
            "end_turn",
            &json!({
                "usage": {
                    "totalTokens": 10_669,
                    "inputTokens": 10_653,
                    "outputTokens": 3,
                    "thoughtTokens": 13,
                }
            }),
        )
        .await;
        let event = rx.recv().await.unwrap().unwrap();
        assert!(
            event.usage().is_none(),
            "session/prompt usage is per-turn accounting, not a context-budget snapshot",
        );
        assert_eq!(event.context_window(), Some(200_000));
        let tokens = event.token_usage().expect("end-turn token usage");
        let RuntimeTokenUsage::Delta { entries, .. } = tokens else {
            panic!("expected per-turn usage");
        };
        assert_eq!(entries[0].input_tokens, 10_653);
        assert_eq!(entries[0].output_tokens, 16);
    }

    #[tokio::test]
    async fn emit_turn_result_can_attach_provider_usage_fallback() {
        let (tx, mut rx) = mpsc::channel(4);
        emit_turn_result(
            &tx,
            Some("s-1".into()),
            Some(200_000),
            Some(crate::domain::agents::adapter::RuntimeUsage {
                input_tokens: 12_345,
                output_tokens: 0,
            }),
            "end_turn",
            &json!({}),
        )
        .await;
        let event = rx.recv().await.unwrap().unwrap();
        let usage = event.usage().expect("provider fallback usage is attached");
        assert_eq!(usage.input_tokens, 12_345);
        assert_eq!(usage.output_tokens, 0);
    }
}
