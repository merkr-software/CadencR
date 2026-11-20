//! The `mcp_servers` session event: what the agent's MCP servers report, or
//! why they could not be read. Each function returns the message; the caller
//! publishes it to the turn's owner and every other viewer of the feature, so
//! a headless turn (HTTP, MCP, a schedule) still reaches them.

use crate::domain::ws_session::protocol::WsSessionEvent;

use axum::extract::ws::Message;
use tracing::{info, warn};

use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeEvent, RuntimeMcpServerStatus};
use crate::domain::ws_session::protocol::{
    McpServerStatusPayload, SessionMcpServersPayload, WsEnvelope,
};

use super::super::{QueryState, SdkSessions};

pub(in crate::domain::ws_session) async fn mcp_servers_message_if_init(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    runtime_event: &RuntimeEvent,
) -> Option<Message> {
    let init = runtime_event.init()?;
    info!(
        db_session_id,
        event_mcp_count = init.mcp_servers.len(),
        "session mcp: init event received, collecting MCP server payload"
    );
    let payload = choose_mcp_servers_payload(
        mcp_servers_payload_from_event(runtime_event),
        mcp_servers_payload_from_active_session(sdk_sessions, db_session_id).await,
    )?;
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending MCP server payload from init",
    );
    Some(message(payload))
}

pub(in crate::domain::ws_session) async fn refreshed_mcp_servers_message(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    closing: impl std::future::Future<Output = ()>,
) -> Option<Message> {
    // The refresh holds the runtime, which shutdown must close in time: once
    // `closing` resolves it is given up, releasing the runtime.
    let payload = tokio::select! {
        () = closing => None,
        payload = refreshed_mcp_servers_payload_from_active_session(sdk_sessions, db_session_id) => payload,
    }?;
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending refreshed MCP server payload after turn",
    );
    Some(message(payload))
}

fn message(payload: SessionMcpServersPayload) -> Message {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::McpServers(payload))
        .expect("session event payload should serialize");
    Message::Text(String::from(envelope).into())
}

/// What the init tells: the servers it lists, else what reading the runtime
/// gave, its failure included. An empty init with no runtime to read says
/// nothing, so nothing is published: an empty list would hide an earlier
/// failure.
fn choose_mcp_servers_payload(
    event: Option<SessionMcpServersPayload>,
    active: Option<SessionMcpServersPayload>,
) -> Option<SessionMcpServersPayload> {
    match (event, active) {
        (Some(event), _) if !event.mcp_servers.is_empty() => Some(event),
        (_, active) => active,
    }
}

async fn mcp_servers_payload_from_active_session(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Option<SessionMcpServersPayload> {
    let query = active_runtime_session(sdk_sessions, db_session_id).await?;
    let session = query.read().await;
    Some(mcp_servers_payload_from_runtime(session.as_ref(), db_session_id).await)
}

async fn refreshed_mcp_servers_payload_from_active_session(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Option<SessionMcpServersPayload> {
    let query = active_runtime_session(sdk_sessions, db_session_id).await?;
    let session = query.read().await;
    Some(mcp_servers_payload_from_runtime_refresh(session.as_ref(), db_session_id).await)
}

async fn active_runtime_session(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Option<crate::domain::agents::adapter::RuntimeSessionHandle> {
    let sessions = sdk_sessions.lock().await;
    let handle = sessions.get(&db_session_id)?;
    let QueryState::Active { query, .. } = &handle.state else {
        return None;
    };
    Some(query.clone())
}

async fn mcp_servers_payload_from_runtime(
    runtime_session: &dyn AgentRuntimeSession,
    db_session_id: i64,
) -> SessionMcpServersPayload {
    match runtime_session.available_mcp_servers().await {
        Ok(servers) => {
            log_runtime_servers(db_session_id, &servers);
            payload_from_servers(servers)
        }
        Err(error) => {
            warn!(
                db_session_id,
                error = %error,
                "session mcp: active runtime failed to report MCP servers"
            );
            SessionMcpServersPayload {
                mcp_servers: Vec::new(),
                error: Some(format!(
                    "The agent's MCP servers could not be read: {error}"
                )),
            }
        }
    }
}

async fn mcp_servers_payload_from_runtime_refresh(
    runtime_session: &dyn AgentRuntimeSession,
    db_session_id: i64,
) -> SessionMcpServersPayload {
    match runtime_session.refresh_mcp_servers().await {
        Ok(servers) => {
            log_runtime_servers(db_session_id, &servers);
            payload_from_servers(servers)
        }
        Err(error) => {
            warn!(
                db_session_id,
                error = %error,
                "session mcp: live refresh failed, falling back to known MCP servers"
            );
            mcp_servers_payload_from_runtime(runtime_session, db_session_id).await
        }
    }
}

fn payload_from_servers(servers: Vec<RuntimeMcpServerStatus>) -> SessionMcpServersPayload {
    SessionMcpServersPayload {
        mcp_servers: servers
            .into_iter()
            .map(|server| McpServerStatusPayload {
                name: server.name,
                status: server.status,
            })
            .collect(),
        error: None,
    }
}

fn log_runtime_servers(db_session_id: i64, servers: &[RuntimeMcpServerStatus]) {
    let names = servers
        .iter()
        .map(|server| format!("{}:{}", server.name, server.status))
        .collect::<Vec<_>>();
    info!(
        db_session_id,
        mcp_count = names.len(),
        mcp_servers = ?names,
        "session mcp: runtime returned MCP servers"
    );
}

fn log_payload(db_session_id: i64, payload: &SessionMcpServersPayload, message: &str) {
    let names = payload
        .mcp_servers
        .iter()
        .map(|server| format!("{}:{}", server.name, server.status))
        .collect::<Vec<_>>();
    info!(
        db_session_id,
        source = message,
        mcp_count = names.len(),
        mcp_servers = ?names,
        unreadable = payload.error.is_some(),
        "session mcp: sending MCP server payload over websocket"
    );
}

pub(in crate::domain::ws_session) fn mcp_servers_payload_from_event(
    runtime_event: &RuntimeEvent,
) -> Option<SessionMcpServersPayload> {
    let init = runtime_event.init()?;
    Some(payload_from_servers(init.mcp_servers.clone()))
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use serde_json::json;

    use super::{
        choose_mcp_servers_payload, mcp_servers_payload_from_event,
        mcp_servers_payload_from_runtime, McpServerStatusPayload, SessionMcpServersPayload,
    };
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
        RuntimeInitEvent, RuntimeMcpServerStatus, RuntimePermissionMode,
    };

    struct TestMcpSession;

    #[async_trait]
    impl AgentRuntimeSession for TestMcpSession {
        fn take_message_rx(&mut self) -> crate::domain::agents::adapter::RuntimeMessageRx {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("runtime-session".to_string())
        }

        async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
            Ok(vec![RuntimeMcpServerStatus {
                name: "chrome-devtools".to_string(),
                status: "pending".to_string(),
            }])
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[test]
    fn mcp_servers_payload_from_init_event_preserves_all_statuses() {
        let event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("sess".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "session.init" }),
            },
            RuntimeEventKind::Init(RuntimeInitEvent {
                model: None,
                mcp_servers: vec![
                    RuntimeMcpServerStatus {
                        name: "cadencr-browser".into(),
                        status: "connected".into(),
                    },
                    RuntimeMcpServerStatus {
                        name: "filesystem".into(),
                        status: "unavailable".into(),
                    },
                ],
                context_window: None,
            }),
        );

        let payload = mcp_servers_payload_from_event(&event).expect("payload");

        assert_eq!(payload.mcp_servers.len(), 2);
        assert_eq!(payload.mcp_servers[0].name, "cadencr-browser");
        assert_eq!(payload.mcp_servers[0].status, "connected");
        assert_eq!(payload.mcp_servers[1].name, "filesystem");
        assert_eq!(payload.mcp_servers[1].status, "unavailable");
    }

    #[test]
    fn mcp_payload_uses_init_event_when_active_session_temporarily_reports_empty() {
        let from_event = SessionMcpServersPayload {
            mcp_servers: vec![McpServerStatusPayload {
                name: "cadencr-browser".into(),
                status: "connected".into(),
            }],
            error: None,
        };
        let active = SessionMcpServersPayload {
            mcp_servers: Vec::new(),
            error: None,
        };

        let payload = choose_mcp_servers_payload(Some(from_event), Some(active)).unwrap();

        assert_eq!(payload.mcp_servers.len(), 1);
        assert_eq!(payload.mcp_servers[0].name, "cadencr-browser");
    }

    /// An init listing no servers used to replace a failed runtime read, and
    /// the panel said "No MCP servers reported" instead of the failure.
    #[test]
    fn an_empty_init_never_hides_an_unreadable_runtime() {
        let empty_init = || SessionMcpServersPayload {
            mcp_servers: Vec::new(),
            error: None,
        };
        let unreadable = SessionMcpServersPayload {
            mcp_servers: Vec::new(),
            error: Some("mcp_status timed out".into()),
        };

        let payload = choose_mcp_servers_payload(Some(empty_init()), Some(unreadable)).unwrap();
        assert!(payload.error.is_some());

        assert!(
            choose_mcp_servers_payload(Some(empty_init()), None).is_none(),
            "an empty init with no runtime to read publishes nothing"
        );
    }

    #[tokio::test]
    async fn mcp_payload_can_be_built_from_runtime_without_init_event() {
        let session = TestMcpSession;

        let payload = mcp_servers_payload_from_runtime(&session, 42).await;

        assert_eq!(payload.mcp_servers.len(), 1);
        assert_eq!(payload.mcp_servers[0].name, "chrome-devtools");
        assert_eq!(payload.mcp_servers[0].status, "pending");
    }

    /// A runtime that cannot report its MCP servers, live or known.
    struct UnreadableMcpSession;

    #[async_trait]
    impl AgentRuntimeSession for UnreadableMcpSession {
        fn take_message_rx(&mut self) -> crate::domain::agents::adapter::RuntimeMessageRx {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        async fn session_id(&self) -> Option<String> {
            None
        }
        async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
            Err(RuntimeError::new("mcp_status timed out"))
        }
        async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
            Err(RuntimeError::new("refresh refused"))
        }
        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    /// An empty list would read as "no MCP servers": a failed read says why.
    #[tokio::test]
    async fn an_unreadable_mcp_list_carries_its_error() {
        let payload = mcp_servers_payload_from_runtime(&UnreadableMcpSession, 42).await;
        assert!(payload.mcp_servers.is_empty());
        let error = payload.error.expect("the failure is reported");
        assert!(error.contains("mcp_status timed out"), "{error}");

        let refreshed =
            super::mcp_servers_payload_from_runtime_refresh(&UnreadableMcpSession, 42).await;
        assert!(refreshed.error.is_some());

        let read = mcp_servers_payload_from_runtime(&TestMcpSession, 42).await;
        assert!(read.error.is_none());
        let wire = serde_json::to_value(&read).unwrap();
        assert!(wire.get("error").is_none(), "{wire}");
    }

    /// A runtime whose live MCP refresh takes as long as a slow CLI answer.
    struct SlowRefreshSession;

    #[async_trait]
    impl AgentRuntimeSession for SlowRefreshSession {
        fn take_message_rx(&mut self) -> crate::domain::agents::adapter::RuntimeMessageRx {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }
        async fn session_id(&self) -> Option<String> {
            None
        }
        async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            Ok(Vec::new())
        }
        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn close(&mut self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }
        fn pid(&self) -> Option<u32> {
            None
        }
    }

    /// Shutdown closes a runtime under its write lock, within a 2 s deadline:
    /// a refresh after the turn must not hold the runtime through it.
    #[tokio::test]
    async fn closing_the_runtime_does_not_wait_on_a_post_turn_refresh() {
        use crate::domain::ws_session::runtime::state::{new_sdk_sessions, QueryState};
        let sessions = new_sdk_sessions();
        let mut handle =
            crate::domain::ws_session::handler::tests::support::make_active_handle(1, None);
        let runtime: crate::domain::agents::adapter::RuntimeSessionHandle =
            std::sync::Arc::new(tokio::sync::RwLock::new(Box::new(SlowRefreshSession)));
        let (permission_tx, _permission_rx) = super::super::permission_response_channel();
        handle.state = QueryState::Active {
            query: runtime.clone(),
            permission_tx,
        };
        sessions.lock().await.insert(7, handle);
        let closing = tokio_util::sync::CancellationToken::new();
        let refresh = tokio::spawn({
            let (sessions, closing) = (sessions.clone(), closing.clone());
            async move {
                super::refreshed_mcp_servers_message(&sessions, 7, closing.cancelled_owned()).await
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        closing.cancel();
        let close = tokio::time::timeout(std::time::Duration::from_millis(500), runtime.write());
        assert!(close.await.is_ok(), "the close waited on the refresh");
        assert!(
            refresh.await.unwrap().is_none(),
            "a given-up refresh sends nothing"
        );
    }
}
