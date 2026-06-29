use claude_agent_sdk_rs::messages::SdkMessage;
use serde_json::json;

#[test]
fn deserializes_rate_limit_event_as_rate_limit_message() {
    let msg: SdkMessage = serde_json::from_value(json!({
        "type": "rate_limit_event",
        "uuid": "u",
        "session_id": "s",
        "rate_limit_info": {
            "status": "allowed",
            "rateLimitType": "five_hour"
        }
    }))
    .expect("rate limit event should deserialize");

    match msg {
        SdkMessage::RateLimit {
            uuid,
            session_id,
            data,
        } => {
            assert_eq!(uuid, "u");
            assert_eq!(session_id, "s");
            assert_eq!(data["rate_limit_info"]["status"], "allowed");
        }
        other => panic!("expected rate limit message, got {other:?}"),
    }
}
