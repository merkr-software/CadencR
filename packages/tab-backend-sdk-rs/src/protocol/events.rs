//! Protocol-v2 unsolicited events and their wire limits.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{codes, Error};

/// Largest serialized event, including its envelope but excluding `\n`.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
/// Largest topic in UTF-8 bytes. Topic names belong to the plugin.
pub const MAX_TOPIC_BYTES: usize = 128;

/// One unsolicited backend update, available only in protocol v2.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// Non-empty, at most [`MAX_TOPIC_BYTES`] bytes, without control characters.
    pub topic: String,
    /// Any JSON value, including `null`; required on the wire.
    pub payload: Value,
}

impl Event {
    pub(crate) fn validate_topic(&self) -> Result<(), Error> {
        if self.topic.is_empty()
            || self.topic.len() > MAX_TOPIC_BYTES
            || self.topic.chars().any(char::is_control)
        {
            return Err(Error::new(
                codes::INVALID_EVENT,
                format!(
                    "`topic` must be 1–{MAX_TOPIC_BYTES} UTF-8 bytes without control characters"
                ),
            ));
        }
        Ok(())
    }
}

/// Validate a complete v2 `event` line (without its newline).
///
/// Unknown fields are tolerated. This does not check handshake order or
/// protocol version: a host must accept events only after a v2 `ready`.
pub fn parse_event(line: &[u8]) -> Result<Event, Error> {
    if line.len() > MAX_EVENT_BYTES {
        return Err(Error::new(
            codes::EVENT_TOO_LARGE,
            format!("the event does not fit in {MAX_EVENT_BYTES} bytes"),
        ));
    }
    let value: Value = serde_json::from_slice(line)
        .map_err(|error| Error::new(codes::INVALID_EVENT, error.to_string()))?;
    if value.get("type").and_then(Value::as_str) != Some("event") || value.get("payload").is_none()
    {
        return Err(Error::new(
            codes::INVALID_EVENT,
            "expected an `event` with a `topic` and a `payload`",
        ));
    }
    let event: Event = serde_json::from_value(value)
        .map_err(|error| Error::new(codes::INVALID_EVENT, error.to_string()))?;
    event.validate_topic()?;
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::BackendMessage;
    use serde_json::json;

    #[test]
    fn event_round_trip_accepts_arbitrary_payloads_and_extra_fields() {
        for payload in [Value::Null, json!([1, "two"]), json!({"state": true})] {
            let event = Event {
                topic: "worker.état".into(),
                payload,
            };
            let line = serde_json::to_vec(&BackendMessage::Event(event.clone())).unwrap();
            assert_eq!(parse_event(&line).unwrap(), event);
        }
        assert!(
            parse_event(br#"{"type":"event","topic":"t","payload":null,"future":true}"#).is_ok()
        );
    }

    #[test]
    fn malformed_events_and_topics_are_rejected() {
        for line in [
            &b"not JSON"[..],
            br#"{"type":"response","topic":"t","payload":null}"#,
            br#"{"type":"event","topic":"t"}"#,
            br#"{"type":"event","topic":5,"payload":null}"#,
            br#"{"type":"event","topic":"","payload":null}"#,
            br#"{"type":"event","topic":"bad\nname","payload":null}"#,
        ] {
            assert_eq!(parse_event(line).unwrap_err().code(), codes::INVALID_EVENT);
        }
        let long_topic = json!({"type":"event","topic":"é".repeat(65),"payload":null});
        assert_eq!(
            parse_event(long_topic.to_string().as_bytes())
                .unwrap_err()
                .code(),
            codes::INVALID_EVENT
        );
        let too_large = json!({"type":"event","topic":"t","payload":"x".repeat(MAX_EVENT_BYTES)});
        assert_eq!(
            parse_event(too_large.to_string().as_bytes())
                .unwrap_err()
                .code(),
            codes::EVENT_TOO_LARGE
        );
    }
}
