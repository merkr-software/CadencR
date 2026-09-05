//! Backend-only bridge for negotiated live session configuration.
//!
//! The desktop consumes these actions as a thin provider-neutral renderer over
//! opaque option ids and authoritative runtime snapshots.

use axum::extract::ws::Message;

use super::super::super::protocol::{
    SessionActionPayload, SessionConfigSetPayload, SessionConfigSnapshotPayload, WsEnvelope,
    WsSessionAction,
};
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;

pub(in crate::domain::ws_session::handler) async fn handle_session_config_get(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };
    let Some((query, _)) = active_query(sdk_sessions, app_state, db_session_id).await else {
        send_error(
            sender,
            &envelope.id,
            "SESSION_NOT_ACTIVE",
            "Session configuration is available after the runtime starts",
        );
        return;
    };
    let session = query.read().await;
    let Some(config) = session.session_config_snapshot().await else {
        send_unsupported(sender, &envelope.id);
        return;
    };
    let reply = WsEnvelope::session_reply(
        &envelope.id,
        WsSessionAction::ConfigSnapshot,
        SessionConfigSnapshotPayload {
            session_id: payload.session_id,
            config,
        },
    )
    .expect("session config snapshot should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

pub(in crate::domain::ws_session::handler) async fn handle_session_config_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionConfigSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };
    let Some((query, feature_id)) = active_query(sdk_sessions, app_state, db_session_id).await
    else {
        send_error(
            sender,
            &envelope.id,
            "SESSION_NOT_ACTIVE",
            "Session configuration is available after the runtime starts",
        );
        return;
    };
    let session = query.read().await;
    if session.session_config_snapshot().await.is_none() {
        send_unsupported(sender, &envelope.id);
        return;
    }
    let config = match session
        .set_session_config_option(&payload.config_id, payload.value)
        .await
    {
        Ok(config) => config,
        Err(error) => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_CONFIG_REJECTED",
                &error.to_string(),
            );
            return;
        }
    };
    drop(session);
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        WsSessionAction::ConfigSnapshot,
        SessionConfigSnapshotPayload {
            session_id: payload.session_id,
            config,
        },
    )
    .await;
}

async fn active_query(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
) -> Option<(RuntimeSessionHandle, i64)> {
    let sessions = super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sessions = sessions.lock().await;
    let handle = sessions.get(&db_session_id)?;
    let QueryState::Active { query, .. } = &handle.state else {
        return None;
    };
    Some((query.clone(), handle.feature_id))
}

fn send_unsupported(sender: &WsSender, envelope_id: &str) {
    send_error(
        sender,
        envelope_id,
        "SESSION_CONFIG_UNSUPPORTED",
        "The active runtime does not expose generic session configuration",
    );
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::extract::ws::Message;
    use serde_json::json;
    use tokio::sync::{mpsc, RwLock};

    use super::{handle_session_config_get, handle_session_config_set};
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
        RuntimeSessionConfigKind, RuntimeSessionConfigOption, RuntimeSessionConfigSnapshot,
        RuntimeSessionConfigValue,
    };
    use crate::domain::ws_session::handler::new_sdk_sessions;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::QueryState;
    use crate::domain::ws_session::protocol::{SessionConfigSnapshotPayload, WsEnvelope};

    struct ConfigSession {
        snapshot: Arc<RwLock<RuntimeSessionConfigSnapshot>>,
    }

    impl ConfigSession {
        fn new() -> Self {
            Self {
                snapshot: Arc::new(RwLock::new(RuntimeSessionConfigSnapshot {
                    options: vec![RuntimeSessionConfigOption {
                        id: "safe_mode".to_string(),
                        name: "Safe mode".to_string(),
                        description: None,
                        category: Some("_acme".to_string()),
                        kind: RuntimeSessionConfigKind::Boolean {
                            current_value: false,
                        },
                        meta: None,
                    }],
                })),
            }
        }
    }

    #[async_trait]
    impl AgentRuntimeSession for ConfigSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            let (_tx, rx) = mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-1".to_string())
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn session_config_snapshot(&self) -> Option<RuntimeSessionConfigSnapshot> {
            Some(self.snapshot.read().await.clone())
        }

        async fn set_session_config_option(
            &self,
            config_id: &str,
            value: RuntimeSessionConfigValue,
        ) -> Result<RuntimeSessionConfigSnapshot, RuntimeError> {
            let mut snapshot = self.snapshot.write().await;
            snapshot
                .validate_value(config_id, &value)
                .map_err(RuntimeError::new)?;
            let RuntimeSessionConfigValue::Boolean(value) = value else {
                return Err(RuntimeError::new("expected boolean"));
            };
            snapshot.options[0].kind = RuntimeSessionConfigKind::Boolean {
                current_value: value,
            };
            Ok(snapshot.clone())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    async fn harness() -> (
        crate::app_state::AppState,
        crate::domain::ws_session::handler::SdkSessions,
        mpsc::UnboundedSender<Message>,
        mpsc::UnboundedReceiver<Message>,
    ) {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let mut handle = make_active_handle(1, Some("runtime-1".to_string()));
        let (permission_tx, _permission_rx) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(ConfigSession::new()))),
            permission_tx,
        };
        sessions.lock().await.insert(7, handle);
        let (sender, receiver) = mpsc::unbounded_channel();
        (app_state, sessions, sender, receiver)
    }

    async fn response(receiver: &mut mpsc::UnboundedReceiver<Message>) -> WsEnvelope {
        let Message::Text(text) = receiver.recv().await.unwrap() else {
            panic!("expected text response");
        };
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn get_returns_the_live_provider_neutral_snapshot() {
        let (app_state, sessions, sender, mut receiver) = harness().await;
        let envelope = WsEnvelope::new("session", "config.get", json!({ "session_id": "7" }));
        let request_id = envelope.id.clone();

        handle_session_config_get(envelope, &sender, &sessions, &app_state).await;

        let response = response(&mut receiver).await;
        assert_eq!(response.action, "config.snapshot");
        assert_eq!(response.r#ref.as_deref(), Some(request_id.as_str()));
        let payload: SessionConfigSnapshotPayload =
            serde_json::from_value(response.payload).unwrap();
        assert_eq!(payload.session_id, "7");
        assert_eq!(payload.config.options[0].id, "safe_mode");
    }

    #[tokio::test]
    async fn set_returns_the_authoritative_replacement_snapshot() {
        let (app_state, sessions, sender, mut receiver) = harness().await;
        let envelope = WsEnvelope::new(
            "session",
            "config.set",
            json!({ "session_id": "7", "config_id": "safe_mode", "value": true }),
        );

        handle_session_config_set(envelope, &sender, &sessions, &app_state).await;

        let response = response(&mut receiver).await;
        let payload: SessionConfigSnapshotPayload =
            serde_json::from_value(response.payload).unwrap();
        assert!(matches!(
            payload.config.options[0].kind,
            RuntimeSessionConfigKind::Boolean {
                current_value: true
            }
        ));
    }
}
