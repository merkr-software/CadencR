use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

use crate::domain::agents::adapter::RuntimeEvent;

const MAX_PENDING_PROMPT_RECEIPTS: usize = 64;

#[derive(Debug, Clone)]
struct PendingClaudePromptReceipt {
    client_message_id: String,
    expected_text: String,
}

#[derive(Debug, Default)]
pub(super) struct ClaudePromptReceipts {
    pending: Mutex<VecDeque<PendingClaudePromptReceipt>>,
}

impl ClaudePromptReceipts {
    pub(super) fn enqueue(&self, client_message_id: String, content: &Value) {
        let expected_text = normalize_text(&content_text(content));
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        pending.push_back(PendingClaudePromptReceipt {
            client_message_id,
            expected_text,
        });
        while pending.len() > MAX_PENDING_PROMPT_RECEIPTS {
            pending.pop_front();
        }
    }

    pub(super) fn acknowledge_replay(&self, message: &Value) -> Option<RuntimeEvent> {
        let observed_text =
            normalize_text(&content_text(message.get("content").unwrap_or(message)));
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        let idx = pending
            .iter()
            .position(|receipt| receipt.matches_observed_text(&observed_text))?;
        let receipt = pending.remove(idx)?;
        Some(RuntimeEvent::prompt_received_event(
            receipt.client_message_id,
        ))
    }

    pub(super) fn discard(&self, client_message_id: &str) {
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        if let Some(idx) = pending
            .iter()
            .position(|receipt| receipt.client_message_id == client_message_id)
        {
            pending.remove(idx);
        }
    }
}

impl PendingClaudePromptReceipt {
    fn matches_observed_text(&self, observed_text: &str) -> bool {
        if self.expected_text.is_empty() || observed_text.is_empty() {
            return false;
        }
        self.expected_text == observed_text
            || self.expected_text.starts_with(observed_text)
            || observed_text.contains(&self.expected_text)
    }
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
            .or_else(|| content.get("content").and_then(Value::as_str))
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
    use serde_json::json;

    use super::ClaudePromptReceipts;

    #[test]
    fn acknowledges_matching_replay_message() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("hello Claude"));

        let event = receipts
            .acknowledge_replay(&json!({
                "role": "user",
                "content": "hello Claude"
            }))
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
        assert!(
            receipts
                .acknowledge_replay(&json!({
                    "role": "user",
                    "content": "hello Claude"
                }))
                .is_none(),
            "receipt should be consumed exactly once"
        );
    }

    #[test]
    fn matches_text_inside_multimodal_content() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue(
            "client-2".to_string(),
            &json!([
                { "type": "text", "text": "look at this" },
                { "type": "image", "source": { "type": "base64", "data": "abc" } }
            ]),
        );

        let event = receipts
            .acknowledge_replay(&json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "look at this" },
                    { "type": "image", "source": { "type": "base64", "data": "abc" } }
                ]
            }))
            .expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-2"));
    }

    #[test]
    fn ignores_mismatched_replay_message() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("first prompt"));

        assert!(
            receipts
                .acknowledge_replay(&json!({
                    "role": "user",
                    "content": "different prompt"
                }))
                .is_none(),
            "mismatched replay should not acknowledge the oldest pending prompt"
        );
    }
}
