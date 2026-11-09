use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

use crate::domain::agents::adapter::RuntimeEvent;

const MAX_PENDING_PROMPT_RECEIPTS: usize = 64;

#[derive(Debug, Clone)]
struct PendingClaudePromptReceipt {
    client_message_id: String,
    /// The `uuid` the message carries to the CLI, fresh per tracked message
    /// (a resend before its echo reuses it): a later retry of the same
    /// client message is a new CLI message, never a duplicate.
    wire_uuid: String,
    expected_text: String,
}

#[derive(Debug, Default)]
pub(super) struct ClaudePromptReceipts {
    pending: Mutex<VecDeque<PendingClaudePromptReceipt>>,
}

impl ClaudePromptReceipts {
    /// Track `client_message_id` until the CLI echoes it. Returns the `uuid`
    /// to send it with.
    pub(super) fn enqueue(&self, client_message_id: String, content: &Value) -> String {
        let expected_text = normalize_text(&prompt_text(content));
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        if let Some(receipt) = pending
            .iter()
            .find(|receipt| receipt.client_message_id == client_message_id)
        {
            return receipt.wire_uuid.clone();
        }
        let wire_uuid = uuid::Uuid::new_v4().to_string();
        pending.push_back(PendingClaudePromptReceipt {
            client_message_id,
            wire_uuid: wire_uuid.clone(),
            expected_text,
        });
        while pending.len() > MAX_PENDING_PROMPT_RECEIPTS {
            pending.pop_front();
        }
        wire_uuid
    }

    /// The CLI `uuid` of a prompt it has not echoed yet, so not taken in.
    pub(super) fn waiting_wire_uuid(&self, client_message_id: &str) -> Option<String> {
        let pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        pending
            .iter()
            .find(|receipt| receipt.client_message_id == client_message_id)
            .map(|receipt| receipt.wire_uuid.clone())
    }

    /// Acknowledge the pending prompts a root user echo is made of. The echo
    /// must be exactly one pending prompt, or several pending prompts joined
    /// in send order (the CLI merges queued steering input). Anything carrying
    /// tool results is never an echo, and partial text overlaps never match.
    pub(super) fn acknowledge_echo(&self, message: &Value) -> Vec<RuntimeEvent> {
        let Some(observed_text) = echo_text(message.get("content").unwrap_or(message)) else {
            return Vec::new();
        };
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        take_echoed_receipts(&mut pending, &observed_text)
            .into_iter()
            .map(PendingClaudePromptReceipt::into_event)
            .collect()
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

    pub(super) fn acknowledge_all_pending(&self) -> Vec<RuntimeEvent> {
        let mut pending = self.pending.lock().expect("ClaudePromptReceipts poisoned");
        pending
            .drain(..)
            .map(PendingClaudePromptReceipt::into_event)
            .collect()
    }
}

impl PendingClaudePromptReceipt {
    fn into_event(self) -> RuntimeEvent {
        RuntimeEvent::prompt_received_event(self.client_message_id)
    }
}

/// Remove and return the receipts `observed` is composed of, or nothing.
fn take_echoed_receipts(
    pending: &mut VecDeque<PendingClaudePromptReceipt>,
    observed: &str,
) -> Vec<PendingClaudePromptReceipt> {
    if observed.is_empty() {
        return Vec::new();
    }
    if let Some(idx) = pending
        .iter()
        .position(|receipt| receipt.expected_text == observed)
    {
        return pending.remove(idx).into_iter().collect();
    }
    let mut rest = observed;
    let mut matched = Vec::new();
    for (idx, receipt) in pending.iter().enumerate() {
        if receipt.expected_text.is_empty() {
            continue;
        }
        let Some(after) = rest.strip_prefix(receipt.expected_text.as_str()) else {
            continue;
        };
        if !after.is_empty() && !after.starts_with(' ') {
            continue;
        }
        matched.push(idx);
        rest = after.trim_start();
        if rest.is_empty() {
            break;
        }
    }
    if !rest.is_empty() || matched.len() < 2 {
        return Vec::new();
    }
    let mut taken: Vec<_> = matched
        .into_iter()
        .rev()
        .filter_map(|idx| pending.remove(idx))
        .collect();
    taken.reverse();
    taken
}

/// Normalized prompt text of a user echo; `None` when the message carries
/// anything other than prompt content (tool results, tool uses).
fn echo_text(content: &Value) -> Option<String> {
    if let Value::Array(items) = content {
        let carries_tool_blocks = items.iter().any(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("tool_result" | "tool_use")
            )
        });
        if carries_tool_blocks {
            return None;
        }
    }
    Some(normalize_text(&prompt_text(content)))
}

/// Text of the prompt's text blocks only. Non-text blocks (images,
/// documents, tool payloads) never contribute.
fn prompt_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.as_str()),
                Value::Object(_) => text_block(item),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => text_block(content).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

/// A `{"type": "text", "text": …}` block (an untyped `{"text": …}` too).
fn text_block(block: &Value) -> Option<&str> {
    let is_text = block
        .get("type")
        .and_then(Value::as_str)
        .is_none_or(|kind| kind == "text");
    is_text.then(|| block.get("text").and_then(Value::as_str))?
}

fn normalize_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::ClaudePromptReceipts;

    fn ack(receipts: &ClaudePromptReceipts, content: Value) -> Vec<String> {
        receipts
            .acknowledge_echo(&json!({ "role": "user", "content": content }))
            .iter()
            .filter_map(|event| event.prompt_received_client_message_id())
            .map(ToOwned::to_owned)
            .collect()
    }

    #[test]
    fn a_waiting_prompt_keeps_one_cli_uuid_until_its_echo() {
        let receipts = ClaudePromptReceipts::default();
        let wire = receipts.enqueue("client-1".to_string(), &json!("hello Claude"));
        assert_eq!(
            receipts.enqueue("client-1".to_string(), &json!("hello Claude")),
            wire
        );
        assert_eq!(receipts.waiting_wire_uuid("client-1"), Some(wire));

        receipts.acknowledge_echo(&json!({"content": "hello Claude"}));
        assert_eq!(receipts.waiting_wire_uuid("client-1"), None, "taken in");
    }

    #[test]
    fn acknowledges_matching_replay_message() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("hello Claude"));

        assert_eq!(ack(&receipts, json!("hello Claude")), ["client-1"]);
        assert!(
            ack(&receipts, json!("hello Claude")).is_empty(),
            "receipt should be consumed exactly once"
        );
    }

    #[test]
    fn duplicate_client_message_id_is_idempotent() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("hello Claude"));
        receipts.enqueue("client-1".to_string(), &json!("hello Claude"));

        assert_eq!(ack(&receipts, json!("hello Claude")), ["client-1"]);
        assert!(
            ack(&receipts, json!("hello Claude")).is_empty(),
            "replaying a pending prompt must not enqueue a duplicate receipt"
        );
    }

    #[test]
    fn matches_text_inside_multimodal_content() {
        let receipts = ClaudePromptReceipts::default();
        let content = json!([
            { "type": "text", "text": "look at this" },
            { "type": "image", "source": { "type": "base64", "data": "abc" } }
        ]);
        receipts.enqueue("client-2".to_string(), &content);

        assert_eq!(ack(&receipts, content), ["client-2"]);
    }

    #[test]
    fn ignores_mismatched_replay_message() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("first prompt"));

        assert!(
            ack(&receipts, json!("different prompt")).is_empty(),
            "mismatched replay should not acknowledge the oldest pending prompt"
        );
    }

    #[test]
    fn short_steer_never_matches_a_tool_result_containing_its_text() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("steer".to_string(), &json!("go"));

        let tool_result = json!([{
            "type": "tool_result",
            "tool_use_id": "toolu_1",
            "content": "go"
        }]);
        assert!(ack(&receipts, tool_result).is_empty());
        let tool_result_blocks = json!([{
            "type": "tool_result",
            "tool_use_id": "toolu_2",
            "content": [{ "type": "text", "text": "good" }]
        }]);
        assert!(ack(&receipts, tool_result_blocks).is_empty());
        assert_eq!(ack(&receipts, json!("go")), ["steer"], "still pending");
    }

    #[test]
    fn partial_text_overlap_is_not_an_echo() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("steer".to_string(), &json!("go"));
        receipts.enqueue("long".to_string(), &json!("fix the lint errors"));

        assert!(ack(&receipts, json!("good morning")).is_empty());
        assert!(ack(&receipts, json!("fix the lint")).is_empty());
        assert!(ack(&receipts, json!("please fix the lint errors now")).is_empty());
    }

    #[test]
    fn merged_queued_echo_acknowledges_each_prompt_it_contains() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("And the lint"));
        receipts.enqueue("client-2".to_string(), &json!("unrelated"));
        receipts.enqueue("client-3".to_string(), &json!("then ts-check"));

        assert_eq!(
            ack(&receipts, json!("And the lint\nthen ts-check")),
            ["client-1", "client-3"]
        );
        assert_eq!(ack(&receipts, json!("unrelated")), ["client-2"]);
    }

    #[test]
    fn acknowledge_all_pending_consumes_every_pending_prompt() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("first prompt"));
        receipts.enqueue("client-2".to_string(), &json!("second prompt"));

        let events = receipts.acknowledge_all_pending();

        let ids: Vec<_> = events
            .iter()
            .filter_map(|event| event.prompt_received_client_message_id())
            .collect();
        assert_eq!(ids, vec!["client-1", "client-2"]);
        assert!(
            receipts.acknowledge_all_pending().is_empty(),
            "bulk acknowledgement should consume pending receipts exactly once"
        );
    }
}
