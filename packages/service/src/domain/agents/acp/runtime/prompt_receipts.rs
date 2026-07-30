//! Tracks locally-generated prompt ids until the ACP agent confirms that the
//! prompt made it into provider-side state. Confirmation can arrive as an
//! explicit `user_message_chunk`, a matching message-id extension, the first
//! new agent message after a known in-flight message, or (as a final fallback)
//! the corresponding `session/prompt` response.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

use serde_json::Value;

use crate::domain::agents::adapter::RuntimeEvent;

#[derive(Debug, Clone)]
struct PendingPromptReceipt {
    client_message_id: String,
    expected_text: String,
    enqueue_agent_message_generation: u64,
}

#[derive(Debug, Default)]
struct PendingPromptReceiptState {
    receipts: VecDeque<PendingPromptReceipt>,
    observed_agent_message_ids: HashSet<String>,
    agent_message_generation: u64,
}

#[derive(Debug, Default)]
pub struct PendingPromptReceipts {
    pending: Mutex<PendingPromptReceiptState>,
}

impl PendingPromptReceipts {
    pub fn enqueue(&self, client_message_id: String, prompt: &[Value]) {
        let expected_text = normalize_text(&prompt_text(prompt));
        let mut pending = self.pending.lock().expect("PendingPromptReceipts poisoned");
        if pending
            .receipts
            .iter()
            .any(|receipt| receipt.client_message_id == client_message_id)
        {
            return;
        }
        let enqueue_agent_message_generation = pending.agent_message_generation;
        pending.receipts.push_back(PendingPromptReceipt {
            client_message_id,
            expected_text,
            enqueue_agent_message_generation,
        });
    }

    pub fn acknowledge_from_session_update(&self, params: &Value) -> Option<RuntimeEvent> {
        let body = params.get("update").unwrap_or(params);
        let kind = body.get("sessionUpdate").and_then(Value::as_str);
        if matches!(kind, Some("agent_message_chunk" | "agent_thought_chunk")) {
            return self
                .acknowledge_from_agent_message_id(body.get("messageId").and_then(Value::as_str));
        }
        if kind != Some("user_message_chunk") {
            return None;
        }
        let observed_message_id = body.get("messageId").and_then(Value::as_str);
        let content = body.get("content").unwrap_or(&Value::Null);
        if content.get("type").and_then(Value::as_str) == Some("compaction") {
            return None;
        }
        let observed_text = normalize_text(&content_text(content));
        let mut pending = self.pending.lock().expect("PendingPromptReceipts poisoned");
        let idx = pending
            .receipts
            .iter()
            .position(|receipt| receipt.matches_observed(observed_message_id, &observed_text))?;
        let receipt = pending.receipts.remove(idx)?;
        Some(receipt.into_event(None))
    }

    pub fn acknowledge_client_message_id(&self, client_message_id: &str) -> Option<RuntimeEvent> {
        let mut pending = self.pending.lock().expect("PendingPromptReceipts poisoned");
        let idx = pending
            .receipts
            .iter()
            .position(|receipt| receipt.client_message_id == client_message_id)?;
        let receipt = pending.receipts.remove(idx)?;
        Some(receipt.into_event(None))
    }

    pub fn discard_client_message_id(&self, client_message_id: &str) {
        let mut pending = self.pending.lock().expect("PendingPromptReceipts poisoned");
        if let Some(idx) = pending
            .receipts
            .iter()
            .position(|receipt| receipt.client_message_id == client_message_id)
        {
            pending.receipts.remove(idx);
        }
    }

    fn acknowledge_from_agent_message_id(&self, message_id: Option<&str>) -> Option<RuntimeEvent> {
        let message_id = message_id?;
        let mut pending = self.pending.lock().expect("PendingPromptReceipts poisoned");
        if pending
            .observed_agent_message_ids
            .insert(message_id.to_string())
        {
            pending.agent_message_generation += 1;
        }
        let idx = pending.receipts.iter().position(|receipt| {
            receipt.enqueue_agent_message_generation > 0
                && pending.agent_message_generation > receipt.enqueue_agent_message_generation
        });
        let receipt = pending.receipts.remove(idx?)?;
        Some(receipt.into_event(Some(message_id)))
    }
}

impl PendingPromptReceipt {
    fn matches_observed(&self, observed_message_id: Option<&str>, observed_text: &str) -> bool {
        if observed_message_id == Some(self.client_message_id.as_str()) {
            return true;
        }
        self.matches_observed_text(observed_text)
    }

    fn matches_observed_text(&self, observed_text: &str) -> bool {
        if self.expected_text.is_empty() || observed_text.is_empty() {
            return true;
        }
        self.expected_text == observed_text
            || self.expected_text.starts_with(observed_text)
            || observed_text.contains(&self.expected_text)
    }

    fn into_event(self, provider_message_id: Option<&str>) -> RuntimeEvent {
        RuntimeEvent::prompt_received_event_with_provider_message_id(
            self.client_message_id,
            provider_message_id.map(ToOwned::to_owned),
        )
    }
}

fn prompt_text(prompt: &[Value]) -> String {
    prompt
        .iter()
        .map(content_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(content_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => content
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::PendingPromptReceipts;
    use serde_json::json;

    #[test]
    fn acknowledges_matching_user_message_chunk() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        let event = receipts
            .acknowledge_from_session_update(&json!({
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "hello" }
                }
            }))
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
    }

    #[test]
    fn acknowledges_user_message_chunk_by_message_id() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        let event = receipts
            .acknowledge_from_session_update(&json!({
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "messageId": "client-1",
                    "content": { "type": "text", "text": "provider-normalized text" }
                }
            }))
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
    }

    #[test]
    fn ignores_compaction_user_chunks() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        assert!(receipts
            .acknowledge_from_session_update(&json!({
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "compaction" }
                }
            }))
            .is_none());
    }

    #[test]
    fn acknowledges_prompt_response_completion_when_user_echo_is_absent() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        let event = receipts
            .acknowledge_client_message_id("client-1")
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
    }

    #[test]
    fn duplicate_client_message_id_is_idempotent() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        let first = receipts
            .acknowledge_client_message_id("client-1")
            .expect("first receipt");
        let second = receipts.acknowledge_client_message_id("client-1");

        assert_eq!(first.prompt_received_client_message_id(), Some("client-1"));
        assert!(
            second.is_none(),
            "replaying a pending prompt must not enqueue a duplicate receipt"
        );
    }

    #[test]
    fn discards_failed_prompt_receipts() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "hello"})],
        );

        receipts.discard_client_message_id("client-1");

        assert!(receipts.acknowledge_client_message_id("client-1").is_none());
    }

    #[test]
    fn acknowledges_new_agent_message_id_after_enqueue_when_user_echo_is_absent() {
        let receipts = PendingPromptReceipts::default();
        assert!(receipts
            .acknowledge_from_session_update(&json!({
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "assistant-before",
                    "content": { "type": "text", "text": "working" }
                }
            }))
            .is_none());
        receipts.enqueue(
            "client-1".to_string(),
            &[json!({"type": "text", "text": "steer"})],
        );

        let event = receipts
            .acknowledge_from_session_update(&json!({
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "assistant-after",
                    "content": { "type": "text", "text": "adjusted" }
                }
            }))
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
        assert_eq!(event.provider_message_id(), Some("assistant-after"));
        assert_eq!(
            event.raw_json()["provider_message_id"],
            "assistant-after",
            "history and live accounting share the provider message identity"
        );
    }
}
