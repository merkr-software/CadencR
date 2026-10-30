use crate::domain::ws_session::protocol::WsSessionEvent;

use axum::extract::ws::Message;
use tracing::{info, warn};

use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeEvent, RuntimeMcpServerStatus};
use crate::domain::ws_session::protocol::{
    McpServerStatusPayload, SessionMcpServersPayload, WsEnvelope,
};

use super::super::{QueryState, SdkSessions, WsSender};

pub(super) async fn send_mcp_servers_if_init(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    runtime_event: &RuntimeEvent,
) -> Result<(), ()> {
    if runtime_event.init().is_none() {
        return Ok(());
    };
    info!(
        db_session_id,
        event_mcp_count = runtime_event
            .init()
            .map_or(0, |init| init.mcp_servers.len()),
        "session mcp: init event received, collecting MCP server payload"
    );
    let payload = choose_mcp_servers_payload(
        mcp_servers_payload_from_event(runtime_event),
        mcp_servers_payload_from_active_session(sdk_sessions, db_session_id).await,
    );
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending MCP server payload from init",
    );
    send_payload(sender, payload)
}

pub(super) async fn send_mcp_servers_for_runtime(
    sender: &WsSender,
    db_session_id: i64,
    runtime_session: &dyn AgentRuntimeSession,
) -> Result<(), ()> {
    let payload = mcp_servers_payload_from_runtime(runtime_session, db_session_id).await;
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending MCP server payload after spawn",
    );
    send_payload(sender, payload)
}

pub(super) async fn refresh_mcp_servers_for_active_session(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Result<(), ()> {
    let Some(payload) =
        refreshed_mcp_servers_payload_from_active_session(sdk_sessions, db_session_id).await
    else {
        return Ok(());
    };
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending refreshed MCP server payload after turn",
    );
    send_payload(sender, payload)
}

fn send_payload(sender: &WsSender, payload: SessionMcpServersPayload) -> Result<(), ()> {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::McpServers(payload))
        .expect("session event payload should serialize");
    sender
        .send(Message::Text(String::from(envelope).into()))
        .map_err(|_| ())
}

fn choose_mcp_servers_payload(
    event: Option<SessionMcpServersPayload>,
    active: Option<SessionMcpServersPayload>,
) -> SessionMcpServersPayload {
    match (event, active) {
        (Some(event), _) if !event.mcp_servers.is_empty() => event,
        (_, Some(active)) => active,
        (Some(event), None) => event,
        (None, None) => SessionMcpServersPayload {
            mcp_servers: Vec::new(),
        },
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
        "session mcp: sending MCP server payload over websocket"
    );
}

pub(super) fn mcp_servers_payload_from_event(
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
        };
        let active = SessionMcpServersPayload {
            mcp_servers: Vec::new(),
        };

        let payload = choose_mcp_servers_payload(Some(from_event), Some(active));

        assert_eq!(payload.mcp_servers.len(), 1);
        assert_eq!(payload.mcp_servers[0].name, "cadencr-browser");
    }

    #[tokio::test]
    async fn mcp_payload_can_be_built_from_runtime_without_init_event() {
        let session = TestMcpSession;

        let payload = mcp_servers_payload_from_runtime(&session, 42).await;

        assert_eq!(payload.mcp_servers.len(), 1);
        assert_eq!(payload.mcp_servers[0].name, "chrome-devtools");
        assert_eq!(payload.mcp_servers[0].status, "pending");
    }
}
