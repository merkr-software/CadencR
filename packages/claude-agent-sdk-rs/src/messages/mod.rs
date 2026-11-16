//! Typed representations of every message the Claude Code CLI can emit.
//!
//! The module is split by responsibility:
//! - [`events`] — streaming event bodies and the `system`/usage/assistant types.
//! - [`sdk_message`] — the public [`SdkMessage`] tagged-union and its helpers.
//! - [`deserialize`] — the custom forward-compatible deserializer for `SdkMessage`.
//! - [`task_lifecycle`] / [`malformed`] — raw-preserving payloads for the
//!   background-task `system` frames and for known messages that failed to decode.

mod deserialize;
mod events;
mod malformed;
mod sdk_message;
mod task_lifecycle;

pub use events::{
    AssistantMessageBody, MessageDeltaBody, MessageStartBody, ModelUsageInfo, StreamEventData,
    SystemMessage,
};
pub use malformed::MalformedMessage;
pub use sdk_message::SdkMessage;
pub use task_lifecycle::{TaskLifecycleEvent, TaskLifecycleKind};

use serde_json::Value;

/// The `session_id` of a payload kept raw, when it is a non-empty string.
fn raw_session_id(raw: &Value) -> Option<&str> {
    raw.get("session_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}
