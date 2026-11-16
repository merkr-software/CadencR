use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::domain::ws_session::protocol::*;

fn to_value<T: serde::Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).expect("payload must serialize")
}

/// Worktree setup now runs inside ws-session only, so it can use the live
/// websocket channel directly instead of the old detachable workflow wrapper.
pub type WsSender = mpsc::UnboundedSender<Message>;

/// Send a `feature.updated` envelope over the given WebSocket sender.
pub fn send_feature_updated_envelope(sender: &WsSender, feature_id: i64, changed: &[&str]) {
    let payload = FeatureUpdatedPayload {
        feature_id,
        changed: changed.iter().map(|s| s.to_string()).collect(),
    };
    let envelope = WsEnvelope::new("feature", "updated", to_value(payload));
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}

/// Send a `session.feature.renamed` envelope over the given WebSocket sender.
pub fn send_feature_renamed_envelope(sender: &WsSender, feature_id: i64, title: &str) {
    let payload = FeatureRenamedPayload {
        feature_id,
        title: title.to_string(),
    };
    let envelope = WsEnvelope::session_event(&WsSessionEvent::FeatureRenamed(payload))
        .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}
