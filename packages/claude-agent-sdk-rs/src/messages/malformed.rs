//! A CLI message whose `type` the SDK models but whose payload failed to decode.
//!
//! Distinct from [`SdkMessage::Unknown`](super::SdkMessage::Unknown) (a message
//! kind the SDK has never seen): the consumer knows what this message *was*
//! — notably a turn-ending `result` — and can act on it even though its fields
//! drifted from the typed schema.

use serde::Serialize;
use serde_json::Value;

use super::raw_session_id;

/// A known message kind that did not match its typed schema, with the decoding
/// error and the wire payload preserved.
///
/// Serializes as the raw payload itself, so it never reaches a raw consumer as
/// `null`.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct MalformedMessage {
    #[serde(skip)]
    message_type: String,
    #[serde(skip)]
    error: String,
    raw: Value,
}

impl MalformedMessage {
    pub(super) fn new(message_type: String, error: String, raw: Value) -> Self {
        Self {
            message_type,
            error,
            raw,
        }
    }

    /// The recognized `type` tag (e.g. `"result"`, `"assistant"`).
    pub fn message_type(&self) -> &str {
        &self.message_type
    }

    /// The `subtype` tag, when the payload carries a string one.
    pub fn subtype(&self) -> Option<&str> {
        self.raw.get("subtype").and_then(Value::as_str)
    }

    /// Why the payload did not match its typed schema.
    pub fn error(&self) -> &str {
        &self.error
    }

    /// The message exactly as the CLI sent it.
    pub fn raw(&self) -> &Value {
        &self.raw
    }

    /// Consume the message, keeping only the wire payload.
    pub fn into_raw(self) -> Value {
        self.raw
    }

    /// `true` for a turn-ending `result` the SDK could not decode. The turn is
    /// over regardless of which of its fields drifted.
    pub fn is_result(&self) -> bool {
        self.message_type == "result"
    }

    /// The CLI's own `is_error` flag, when it is still a boolean.
    pub fn reported_is_error(&self) -> Option<bool> {
        self.raw.get("is_error").and_then(Value::as_bool)
    }

    pub fn session_id(&self) -> Option<&str> {
        raw_session_id(&self.raw)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::MalformedMessage;

    #[test]
    fn exposes_tags_and_serializes_as_the_raw_payload() {
        let raw = json!({
            "type": "result", "subtype": 7, "session_id": "s", "is_error": false
        });
        let message = MalformedMessage::new("result".into(), "bad subtype".into(), raw.clone());
        assert!(message.is_result());
        assert_eq!(message.message_type(), "result");
        assert_eq!(message.subtype(), None);
        assert_eq!(message.error(), "bad subtype");
        assert_eq!(message.reported_is_error(), Some(false));
        assert_eq!(message.session_id(), Some("s"));
        assert_eq!(serde_json::to_value(&message).unwrap(), raw);
        assert_eq!(message.into_raw(), raw);
    }

    #[test]
    fn non_result_is_not_a_turn_end() {
        let message = MalformedMessage::new(
            "assistant".into(),
            "missing field".into(),
            json!({ "type": "assistant", "session_id": "" }),
        );
        assert!(!message.is_result());
        assert_eq!(message.session_id(), None);
        assert_eq!(message.reported_is_error(), None);
    }
}
