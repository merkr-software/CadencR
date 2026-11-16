use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tracing::warn;

use super::malformed::MalformedMessage;
use super::sdk_message::SdkMessage;
use super::task_lifecycle::TaskLifecycleEvent;

mod convert;
mod inner;
mod lenient;

use inner::{SdkMessageInner, KNOWN_SYSTEM_SUBTYPES, KNOWN_TYPES};

// ── Custom Deserialize for SdkMessage ────────────────────────────────────────

impl SdkMessage {
    /// Convert a raw CLI wire message into an `SdkMessage`, infallibly.
    ///
    /// Never silently drops, and every outcome keeps the wire payload:
    /// - a background-task lifecycle frame becomes `TaskLifecycle`;
    /// - a message matching its typed schema becomes that variant;
    /// - a known message kind that fails to decode becomes `Malformed`, which
    ///   keeps its `type` so a drifted `result` still ends the turn;
    /// - a message kind the SDK has never seen becomes `Unknown`.
    ///
    /// The last two log exactly what and why, so a CLI wire-format drift is
    /// diagnosable instead of presenting as an agent that "just stopped".
    pub fn from_raw(raw: Value) -> Self {
        let raw = match TaskLifecycleEvent::recognize(raw) {
            Ok(event) => return SdkMessage::TaskLifecycle(event),
            Err(raw) => raw,
        };
        let error = match SdkMessageInner::deserialize(&raw) {
            Ok(inner) => return SdkMessage::from(inner),
            Err(error) => error.to_string(),
        };
        let message_type = raw.get("type").and_then(Value::as_str);
        let subtype = raw.get("subtype").and_then(Value::as_str);
        match message_type.filter(|kind| is_known_kind(kind, subtype)) {
            Some(message_type) => {
                let message_type = message_type.to_owned();
                warn!(
                    message_type = message_type.as_str(),
                    ?subtype,
                    %error,
                    "claude SDK: known message failed to match its schema; forwarding as Malformed"
                );
                SdkMessage::Malformed(MalformedMessage::new(message_type, error, raw))
            }
            None => {
                warn!(
                    message_type = message_type.unwrap_or("<missing>"),
                    ?subtype,
                    %error,
                    "claude SDK: message did not match any known schema; forwarding as Unknown (it will not render in the conversation)"
                );
                SdkMessage::Unknown(raw)
            }
        }
    }
}

/// Whether the SDK models this `type` (and, for `system`, this `subtype`).
fn is_known_kind(message_type: &str, subtype: Option<&str>) -> bool {
    if message_type == "system" {
        return subtype.is_some_and(|subtype| KNOWN_SYSTEM_SUBTYPES.contains(&subtype));
    }
    KNOWN_TYPES.contains(&message_type)
}

impl<'de> Deserialize<'de> for SdkMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        // Buffer the raw value so the fallback can keep it on failure.
        let raw = Value::deserialize(deserializer)?;
        Ok(SdkMessage::from_raw(raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::messages::TaskLifecycleKind;

    #[test]
    fn known_type_list_matches_the_typed_schema() {
        // Every listed tag is one serde recognizes (its failure is about the
        // payload, not the variant); an unlisted tag is an unknown variant.
        for message_type in KNOWN_TYPES {
            let error = SdkMessageInner::deserialize(&json!({ "type": message_type }))
                .err()
                .map(|error| error.to_string())
                .unwrap_or_default();
            assert!(
                !error.contains("unknown variant"),
                "{message_type}: {error}"
            );
        }
        for subtype in KNOWN_SYSTEM_SUBTYPES {
            let error =
                SdkMessageInner::deserialize(&json!({ "type": "system", "subtype": subtype }))
                    .err()
                    .map(|error| error.to_string())
                    .unwrap_or_default();
            assert!(
                !error.contains("unknown variant"),
                "system/{subtype}: {error}"
            );
        }
        let error = SdkMessageInner::deserialize(&json!({ "type": "never_seen" }))
            .err()
            .expect("unknown tag fails");
        assert!(error.to_string().contains("unknown variant"), "{error}");
    }

    #[test]
    fn result_tolerates_missing_null_and_drifted_fields() {
        let msg = SdkMessage::from_raw(json!({
            "type": "result",
            "subtype": "error_during_execution",
            "session_id": "s",
            "duration_ms": null,
            "duration_api_ms": "fast",
            "num_turns": -1,
            "is_error": true,
            "result": { "text": "moved" },
            "usage": { "input_tokens": 3, "server_tool_use": {} },
            "permission_denials": [{ "tool_name": "Bash" }],
            "modelUsage": { "m": { "contextWindow": 200000 } },
            "new_field": 1
        }));
        let SdkMessage::Result {
            subtype,
            uuid,
            duration_ms,
            duration_api_ms,
            num_turns,
            is_error,
            result,
            total_cost_usd,
            usage,
            permission_denials,
            extra,
            ..
        } = &msg
        else {
            panic!("a drifted result must stay a Result, got {msg:?}");
        };
        assert_eq!(subtype, "error_during_execution");
        assert_eq!(uuid, "");
        assert_eq!((*duration_ms, *duration_api_ms, *num_turns), (0, 0, 0));
        assert!(*is_error);
        assert_eq!(result, &None);
        assert_eq!(*total_cost_usd, 0.0);
        assert_eq!((usage.input_tokens, usage.output_tokens), (3, 0));
        assert_eq!(permission_denials.len(), 1);
        assert_eq!(permission_denials[0].tool_name, "Bash");
        assert_eq!(permission_denials[0].tool_use_id, "");
        assert_eq!(extra["new_field"], 1);
        assert_eq!(msg.result_context_window(), Some(200_000));
        assert!(msg.is_turn_complete());
        assert_eq!(msg.session_id(), Some("s"));
    }

    #[test]
    fn unusable_is_error_is_derived_from_the_subtype() {
        let is_error = |raw: Value| match SdkMessage::from_raw(raw) {
            SdkMessage::Result { is_error, .. } => is_error,
            other => panic!("expected Result, got {other:?}"),
        };
        for (subtype, flag, expected) in [
            ("error_during_execution", json!("true"), true),
            ("error_max_turns", Value::Null, true),
            ("success", json!(1), false),
            ("success", Value::Null, false),
            // A usable flag always wins over the subtype.
            ("error_during_execution", json!(false), false),
            ("success", json!(true), true),
        ] {
            let raw = json!({ "type": "result", "subtype": subtype, "is_error": flag });
            assert_eq!(is_error(raw), expected, "{subtype} / {flag}");
        }
        assert!(is_error(
            json!({ "type": "result", "subtype": "error_during_execution" })
        ));
    }

    #[test]
    fn minimal_result_is_typed_without_a_session_id() {
        let msg = SdkMessage::from_raw(json!({ "type": "result", "subtype": "success" }));
        assert!(matches!(msg, SdkMessage::Result { .. }), "got {msg:?}");
        assert_eq!(
            msg.session_id(),
            None,
            "an absent session id is not captured as \"\""
        );
    }

    #[test]
    fn result_without_a_subtype_is_malformed_but_ends_the_turn() {
        let raw = json!({ "type": "result", "session_id": "s", "is_error": false });
        let msg = SdkMessage::from_raw(raw.clone());
        let SdkMessage::Malformed(malformed) = &msg else {
            panic!("expected Malformed, got {msg:?}");
        };
        assert!(malformed.is_result());
        assert!(
            malformed.error().contains("subtype"),
            "{}",
            malformed.error()
        );
        assert!(msg.is_turn_complete());
        assert_eq!(msg.session_id(), Some("s"));
        assert_eq!(serde_json::to_value(&msg).unwrap(), raw);
    }

    #[test]
    fn known_types_failing_their_schema_are_malformed_not_unknown() {
        for raw in [
            json!({ "type": "assistant", "session_id": "s" }),
            json!({ "type": "stream_event", "session_id": "s", "event": 3 }),
            json!({ "type": "system", "subtype": "init", "model": "m" }),
        ] {
            let msg = SdkMessage::from_raw(raw.clone());
            let SdkMessage::Malformed(malformed) = &msg else {
                panic!("expected Malformed for {raw}, got {msg:?}");
            };
            assert_eq!(Some(malformed.message_type()), raw["type"].as_str());
            assert!(!msg.is_turn_complete());
            assert_eq!(serde_json::to_value(&msg).unwrap(), raw);
        }
    }

    #[test]
    fn unseen_kinds_stay_unknown_and_serialize_as_raw() {
        for raw in [
            json!({ "type": "some_future_type", "session_id": "s" }),
            json!({ "type": "system", "subtype": "api_retry", "attempt": 2 }),
            json!({ "no_type": true }),
        ] {
            let msg = SdkMessage::from_raw(raw.clone());
            assert!(matches!(msg, SdkMessage::Unknown(_)), "got {msg:?}");
            assert_eq!(
                serde_json::to_value(&msg).unwrap(),
                raw,
                "raw is never null"
            );
        }
    }

    #[test]
    fn task_lifecycle_frames_are_typed_with_their_raw() {
        let raw = json!({
            "type": "system", "subtype": "task_notification", "uuid": "u",
            "session_id": "s", "task_id": "t", "status": "completed"
        });
        let msg: SdkMessage = serde_json::from_value(raw.clone()).unwrap();
        let SdkMessage::TaskLifecycle(event) = &msg else {
            panic!("expected TaskLifecycle, got {msg:?}");
        };
        assert_eq!(event.kind(), TaskLifecycleKind::Notification);
        assert_eq!(msg.session_id(), Some("s"));
        assert_eq!(serde_json::to_value(&msg).unwrap(), raw);
    }

    #[test]
    fn rate_limit_event_round_trips_with_its_wire_tag() {
        for tag in ["rate_limit_event", "rate_limit"] {
            let msg = SdkMessage::from_raw(json!({
                "type": tag, "uuid": "u", "session_id": "s",
                "rate_limit_info": { "status": "allowed" }
            }));
            assert!(matches!(msg, SdkMessage::RateLimit { .. }), "got {msg:?}");
            let raw = serde_json::to_value(&msg).unwrap();
            assert_eq!(raw["type"], "rate_limit_event");
            assert_eq!(raw["rate_limit_info"]["status"], "allowed");
        }
    }

    #[test]
    fn deserializes_api_error_markers_on_assistant() {
        let msg: SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": { "id": "syn", "model": "<synthetic>", "content": [] },
            "error": "server_error",
            "isApiErrorMessage": true,
            "apiErrorStatus": 529
        }))
        .expect("valid assistant");

        match msg {
            SdkMessage::Assistant {
                is_api_error_message,
                api_error_status,
                error,
                ..
            } => {
                assert!(is_api_error_message);
                assert_eq!(api_error_status, Some(529));
                assert_eq!(error.as_deref(), Some("server_error"));
            }
            other => panic!("expected assistant, got {other:?}"),
        }
    }

    #[test]
    fn defaults_api_error_markers_when_absent() {
        let msg: SdkMessage = serde_json::from_value(json!({
            "type": "assistant",
            "uuid": "u",
            "session_id": "s",
            "message": { "id": "m", "model": "claude-opus-4-8", "content": [] }
        }))
        .expect("valid assistant");

        match msg {
            SdkMessage::Assistant {
                is_api_error_message,
                api_error_status,
                ..
            } => {
                assert!(!is_api_error_message);
                assert_eq!(api_error_status, None);
            }
            other => panic!("expected assistant, got {other:?}"),
        }
    }
}
