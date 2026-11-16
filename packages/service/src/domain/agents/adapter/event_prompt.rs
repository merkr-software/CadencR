//! Prompt delivery events: the runtime took a user prompt in, or dropped it.

use super::event_types::{RuntimeEventKind, RuntimeEventMetadata};
use super::RuntimeEvent;

impl RuntimeEvent {
    pub fn prompt_received_client_message_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::PromptReceived { client_message_id } => Some(client_message_id),
            _ => None,
        }
    }

    pub fn prompt_dropped_client_message_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::PromptDropped { client_message_id } => Some(client_message_id),
            _ => None,
        }
    }

    pub fn prompt_dropped_event(client_message_id: String) -> Self {
        Self::new(
            RuntimeEventMetadata {
                raw: serde_json::json!({
                    "type": "prompt_dropped",
                    "client_message_id": client_message_id,
                }),
                ..RuntimeEventMetadata::default()
            },
            RuntimeEventKind::PromptDropped { client_message_id },
        )
    }

    pub fn prompt_received_event(client_message_id: String) -> Self {
        Self::prompt_received_event_with_provider_message_id(client_message_id, None)
    }

    pub fn prompt_received_event_with_provider_message_id(
        client_message_id: String,
        provider_message_id: Option<String>,
    ) -> Self {
        Self::new(
            RuntimeEventMetadata {
                raw: serde_json::json!({
                    "type": "prompt_received",
                    "client_message_id": client_message_id,
                    "provider_message_id": provider_message_id.clone(),
                }),
                ..RuntimeEventMetadata::default()
            },
            RuntimeEventKind::PromptReceived { client_message_id },
        )
        .with_provider_message_id(provider_message_id)
    }
}
