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
        let mut client_message_ids = self
            .client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned");
        if client_message_ids.iter().any(|id| id == &client_message_id) {
            return;
        }
        client_message_ids.push_back(client_message_id);
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
        let client_id = params
            .get("item")
            .and_then(|item| item.get("clientId"))
            .and_then(Value::as_str);
        let mut pending = self
            .client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned");
        let received_id = match client_id {
            Some(client_id) => pending
                .iter()
                .position(|id| id == client_id)
                .and_then(|index| pending.remove(index)),
            None => pending.pop_front(),
        };
        received_id.map(RuntimeEvent::prompt_received_event)
    }

    /// A stopped root turn ended: Codex recorded the steers it kept before
    /// this (their receipts came first) and dropped the rest, returned here.
    /// Their receipts would otherwise acknowledge a later message that carries
    /// no client id.
    pub(super) fn drop_after_interrupted_turn(
        &self,
        method: &str,
        params: &Value,
        root_thread_id: &str,
    ) -> Vec<RuntimeEvent> {
        let interrupted = method == "turn/completed"
            && belongs_to_root_thread(params, root_thread_id)
            && params["turn"]["status"] == "interrupted";
        if !interrupted {
            return Vec::new();
        }
        let mut pending = self
            .client_message_ids
            .lock()
            .expect("PendingPromptReceipts poisoned");
        pending
            .drain(..)
            .map(RuntimeEvent::prompt_dropped_event)
            .collect()
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

    /// Found live: a steer Codex dropped at a Stop kept its receipt, and the
    /// next prompt's user message (no client id) acknowledged it.
    #[test]
    fn an_interrupted_turn_forgets_the_steers_codex_dropped() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("dropped".to_string());
        let completed = |status: &str| json!({"threadId": "thread-root", "turn": {"id": "t", "status": status}});

        let normal = receipts.drop_after_interrupted_turn(
            "turn/completed",
            &completed("completed"),
            "thread-root",
        );
        assert!(normal.is_empty());
        assert_eq!(
            receipts.front().as_deref(),
            Some("dropped"),
            "a normal end keeps it"
        );

        let dropped = receipts.drop_after_interrupted_turn(
            "turn/completed",
            &completed("interrupted"),
            "thread-root",
        );
        assert_eq!(dropped.len(), 1);
        assert_eq!(
            dropped[0].prompt_dropped_client_message_id(),
            Some("dropped")
        );
        assert!(receipts.front().is_none());
    }

    #[test]
    fn duplicate_client_message_id_is_idempotent() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
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

        let first =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");
        let second =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert_eq!(
            first.and_then(|event| event
                .prompt_received_client_message_id()
                .map(ToOwned::to_owned)),
            Some("client-1".to_string())
        );
        assert!(
            second.is_none(),
            "replaying a pending prompt must not enqueue a duplicate receipt"
        );
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
    fn completed_user_message_uses_echoed_client_id() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
        receipts.enqueue("client-2".to_string());
        let params = json!({
            "threadId": "thread-root",
            "turnId": "turn-1",
            "item": {
                "type": "userMessage",
                "id": "user-message-2",
                "clientId": "client-2",
                "content": [{ "type": "text", "text": "second steer" }]
            }
        });

        let event =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert_eq!(
            event.and_then(|event| event
                .prompt_received_client_message_id()
                .map(ToOwned::to_owned)),
            Some("client-2".to_string())
        );
        assert_eq!(receipts.front().as_deref(), Some("client-1"));
    }

    #[test]
    fn unknown_echoed_client_id_does_not_consume_pending_receipt() {
        let receipts = PendingPromptReceipts::default();
        receipts.enqueue("client-1".to_string());
        let params = json!({
            "threadId": "thread-root",
            "turnId": "turn-1",
            "item": {
                "type": "userMessage",
                "id": "unrelated-user-message",
                "clientId": "untracked-client",
                "content": [{ "type": "text", "text": "unrelated" }]
            }
        });

        let event =
            receipts.acknowledge_completed_user_message("item/completed", &params, "thread-root");

        assert!(event.is_none());
        assert_eq!(receipts.front().as_deref(), Some("client-1"));
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
