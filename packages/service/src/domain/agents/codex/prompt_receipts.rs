//! Tracks Codex steering prompt ids until Codex confirms the corresponding
//! user message exists in the root thread.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

use super::event_turn_state::belongs_to_root_thread;
use crate::domain::agents::adapter::RuntimeEvent;

#[derive(Debug, Default)]
pub(super) struct PendingPromptReceipts {
    client_message_ids: Mutex<VecDeque<String>>,
}

impl PendingPromptReceipts {
    pub(super) fn enqueue(&self, client_message_id: String) {
        self.client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned")
            .push_back(client_message_id);
    }

    pub(super) fn acknowledge_completed_user_message(
        &self,
        method: &str,
        params: &Value,
        root_thread_id: &str,
    ) -> Option<RuntimeEvent> {
        if method != "item/completed" || !is_root_user_message_item(params, root_thread_id) {
            return None;
        }
        self.client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned")
            .pop_front()
            .map(RuntimeEvent::prompt_received_event)
    }

    pub(super) fn discard(&self, client_message_id: &str) {
        let mut pending = self
            .client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned");
        if let Some(index) = pending.iter().position(|id| id == client_message_id) {
            pending.remove(index);
        }
    }

    pub(super) fn clear(&self) {
        self.client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned")
            .clear();
    }

    #[cfg(test)]
    fn front(&self) -> Option<String> {
        self.client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned")
            .front()
            .cloned()
    }
}

fn is_root_user_message_item(params: &Value, root_thread_id: &str) -> bool {
    belongs_to_root_thread(params, root_thread_id)
        && params
            .get("item")
            .and_then(|item| item.get("type"))
            .and_then(Value::as_str)
            == Some("userMessage")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::PendingPromptReceipts;

    #[test]
    fn completed_user_message_emits_next_pending_prompt_receipt() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
        let params = json!({
            "threadId": "thread-root",
            "turnId": "turn-1",
            "item": {
                "type": "userMessage",
                "id": "user-message-1",
                "content": [{ "type": "text", "text": "please steer" }]
            }
        });

        let event =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert_eq!(
            event.and_then(|event| {
                event
                    .prompt_received_client_message_id()
                    .map(ToOwned::to_owned)
            }),
            Some("client-1".to_string())
        );
        assert!(receipts.front().is_none());
    }

    #[test]
    fn completed_user_message_without_thread_id_emits_prompt_receipt() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
        let params = json!({
            "turnId": "turn-1",
            "item": {
                "type": "userMessage",
                "id": "user-message-1",
                "content": [{ "type": "text", "text": "please steer" }]
            }
        });

        let event =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert_eq!(
            event.and_then(|event| {
                event
                    .prompt_received_client_message_id()
                    .map(ToOwned::to_owned)
            }),
            Some("client-1".to_string())
        );
        assert!(receipts.front().is_none());
    }

    #[test]
    fn subagent_user_message_does_not_consume_root_prompt_receipt() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
        let params = json!({
            "threadId": "thread-subagent",
            "turnId": "turn-subagent",
            "item": {
                "type": "userMessage",
                "id": "subagent-user-message",
                "content": [{ "type": "text", "text": "subagent prompt" }]
            }
        });

        let event =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert!(event.is_none());
        assert_eq!(receipts.front().as_deref(), Some("client-1"));
    }
}
