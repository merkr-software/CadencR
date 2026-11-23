//! The `mcp_servers` session event: what the agent's MCP servers report, or
//! why they could not be read. Live updates reach the feature's viewers, who
//! apply snapshots only to the identified conversation.

use std::sync::Arc;

use axum::extract::ws::Message;
use tracing::{info, warn};

use crate::domain::agents::adapter::{
    AgentRuntimeSession, RuntimeEvent, RuntimeMcpServerStatus, RuntimeSessionHandle,
};
use crate::domain::ws_session::protocol::{
    McpServerStatusPayload, SessionMcpServersPayload, WsEnvelope, WsSessionEvent,
};
use crate::domain::ws_session::stream_readers::process_alive;
use crate::shared::discard::IgnoreClosed;

use super::super::{QueryState, SdkSessions, WsSender};

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
    // An empty init is inconclusive. Prefer a runtime read, including its
    // error, rather than presenting silence as an empty catalog.
    let payload = if init.mcp_servers.is_empty() {
        mcp_servers_payload_from_active_session(sdk_sessions, db_session_id).await?
    } else {
        payload_from_servers(db_session_id, init.mcp_servers.clone())
    };
    log_payload(
        db_session_id,
        &payload,
        "session mcp: sending MCP server payload from init",
    );
    Some(message(payload))
}

pub(super) async fn current_mcp_servers_message(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
) -> Option<Message> {
    mcp_servers_payload_from_active_session(sdk_sessions, db_session_id)
        .await
        .map(message)
}

pub(in crate::domain::ws_session) async fn replay_cached_mcp_servers(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    expected: &RuntimeSessionHandle,
    viewer: &WsSender,
) {
    let snapshot = async {
        let runtime = expected.read().await;
        let servers = runtime.cached_mcp_servers().await?;
        Some((servers, runtime.pid()))
    };
    let Some((servers, pid)) = (tokio::select! {
        () = crate::domain::ws_session::stream_readers::closing() => None,
        result = snapshot => result,
    }) else {
        return;
    };
    // Recheck the binding under the registry lock before queuing the snapshot.
    // The runtime guard is already gone, so the locks cannot block teardown.
    let sessions = sdk_sessions.lock().await;
    let Some(QueryState::Active { query, .. }) =
        sessions.get(&db_session_id).map(|handle| &handle.state)
    else {
        return;
    };
    if !Arc::ptr_eq(query, expected) || pid.is_some_and(|pid| !process_alive(pid)) {
        return;
    }
    viewer
        .send(mcp_servers_message_from_servers(db_session_id, servers))
        .ignore_closed();
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

pub(in crate::domain::ws_session) fn mcp_servers_message_from_servers(
    db_session_id: i64,
    servers: Vec<RuntimeMcpServerStatus>,
) -> Message {
    message(payload_from_servers(db_session_id, servers))
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
) -> Option<RuntimeSessionHandle> {
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
            payload_from_servers(db_session_id, servers)
        }
        Err(error) => {
            warn!(
                db_session_id,
                error = %error,
                "session mcp: active runtime failed to report MCP servers"
            );
            SessionMcpServersPayload {
                session_id: db_session_id.to_string(),
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
            payload_from_servers(db_session_id, servers)
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

fn payload_from_servers(
    db_session_id: i64,
    servers: Vec<RuntimeMcpServerStatus>,
) -> SessionMcpServersPayload {
    SessionMcpServersPayload {
        session_id: db_session_id.to_string(),
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

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use serde_json::json;

    use super::{
        mcp_servers_message_if_init, mcp_servers_payload_from_runtime, replay_cached_mcp_servers,
        QueryState, RuntimeSessionHandle, SessionMcpServersPayload, WsEnvelope,
    };
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
        RuntimeInitEvent, RuntimeMcpServerStatus, RuntimePermissionMode,
    };
    use crate::domain::ws_session::handler::tests::support::{
        init_session, make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::runtime::state::{new_sdk_sessions, SdkHandle};
    use axum::extract::ws::Message;
    use futures::FutureExt;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    #[derive(Default)]
    struct TestMcpSession {
        closed: bool,
        cache_only: bool,
    }

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
            assert!(!self.cache_only, "reattaching must use the cached snapshot");
            Ok(self.cached_mcp_servers().await.unwrap())
        }

        async fn cached_mcp_servers(&self) -> Option<Vec<RuntimeMcpServerStatus>> {
            (!self.closed).then(|| {
                vec![RuntimeMcpServerStatus {
                    name: "chrome-devtools".to_string(),
                    status: "pending".to_string(),
                }]
            })
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) -> Result<(), RuntimeError> {
            self.closed = true;
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

    fn init_event(mcp_servers: Vec<RuntimeMcpServerStatus>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("sess".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "session.init" }),
            },
            RuntimeEventKind::Init(RuntimeInitEvent {
                model: None,
                mcp_servers,
                context_window: None,
            }),
        )
    }

    fn decode_snapshot(message: Message) -> SessionMcpServersPayload {
        let Message::Text(text) = message else {
            panic!("expected an MCP snapshot envelope");
        };
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope.action, "mcp_servers");
        assert!(envelope.r#ref.is_none());
        serde_json::from_value(envelope.payload).unwrap()
    }

    #[tokio::test]
    async fn a_reported_init_catalog_keeps_its_statuses_without_reading_the_runtime() {
        let event = init_event(vec![
            RuntimeMcpServerStatus {
                name: "cadencr-browser".into(),
                status: "connected".into(),
            },
            RuntimeMcpServerStatus {
                name: "filesystem".into(),
                status: "unavailable".into(),
            },
        ]);
        let sessions = new_sdk_sessions();
        let _held = sessions.lock().await;
        let message = mcp_servers_message_if_init(&sessions, 42, &event)
            .now_or_never()
            .expect("nonempty init never waits on the registry")
            .unwrap();
        let payload = decode_snapshot(message);

        assert_eq!(payload.session_id, "42");
        assert_eq!(payload.mcp_servers.len(), 2);
        assert_eq!(payload.mcp_servers[0].name, "cadencr-browser");
        assert_eq!(payload.mcp_servers[0].status, "connected");
        assert_eq!(payload.mcp_servers[1].name, "filesystem");
        assert_eq!(payload.mcp_servers[1].status, "unavailable");
    }

    /// An init listing no servers used to replace a failed runtime read, and
    /// the panel said "No MCP servers reported" instead of the failure.
    #[tokio::test]
    async fn an_empty_init_never_hides_an_unreadable_runtime() {
        let sessions = new_sdk_sessions();
        let event = init_event(Vec::new());
        assert!(
            mcp_servers_message_if_init(&sessions, 42, &event)
                .await
                .is_none(),
            "an empty init with no runtime to read publishes nothing"
        );
        let runtime: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(UnreadableMcpSession)));
        sessions.lock().await.insert(42, active_handle(runtime));
        let message = mcp_servers_message_if_init(&sessions, 42, &event)
            .await
            .unwrap();
        let payload = decode_snapshot(message);
        assert_eq!(payload.session_id, "42");
        assert!(payload.error.unwrap().contains("mcp_status timed out"));
    }

    fn active_handle(runtime: RuntimeSessionHandle) -> SdkHandle {
        let mut handle = make_active_handle(1, None);
        let (permission_tx, _) = super::super::permission_response_channel();
        handle.state = QueryState::Active {
            query: runtime,
            permission_tx,
        };
        handle
    }

    #[tokio::test]
    async fn reconnect_replays_the_cached_catalog_to_only_the_new_viewer() {
        let state = make_test_app_state().await;
        let (owner, mut owner_rx) = mpsc::unbounded_channel();
        let sessions = new_sdk_sessions();
        let id = init_session(&owner, &mut owner_rx, &sessions, &state, 1).await;
        let db_session_id = id.parse().unwrap();
        let runtime: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(TestMcpSession {
            cache_only: true,
            ..TestMcpSession::default()
        })));
        sessions
            .lock()
            .await
            .insert(db_session_id, active_handle(runtime));

        let (viewer, mut viewer_rx) = mpsc::unbounded_channel();
        let viewer_sessions = new_sdk_sessions();
        let reconnected = init_session(&viewer, &mut viewer_rx, &viewer_sessions, &state, 1).await;
        assert_eq!(reconnected, id);
        let payload = decode_snapshot(viewer_rx.try_recv().unwrap());
        assert_eq!(payload.session_id, id);
        assert_eq!(payload.mcp_servers[0].name, "chrome-devtools");
        assert_eq!(payload.mcp_servers[0].status, "pending");
        assert!(
            owner_rx.try_recv().is_err(),
            "the owner's socket got a replay"
        );
    }

    #[tokio::test]
    async fn rebind_rejects_replaced_and_closed_runtimes_but_waits_on_a_live_one() {
        let sessions = new_sdk_sessions();
        let replaced: RuntimeSessionHandle =
            Arc::new(RwLock::new(Box::new(TestMcpSession::default())));
        let current: RuntimeSessionHandle =
            Arc::new(RwLock::new(Box::new(TestMcpSession::default())));
        sessions
            .lock()
            .await
            .insert(42, active_handle(current.clone()));
        let (viewer, mut messages) = mpsc::unbounded_channel();

        replay_cached_mcp_servers(&sessions, 42, &replaced, &viewer).await;
        assert!(messages.try_recv().is_err());

        let writing = current.write().await;
        let mut replay =
            std::pin::pin!(replay_cached_mcp_servers(&sessions, 42, &current, &viewer));
        assert!(futures::poll!(&mut replay).is_pending());
        drop(writing);
        replay.await;
        assert_eq!(
            decode_snapshot(messages.try_recv().unwrap()).session_id,
            "42"
        );

        current.write().await.close().await.unwrap();
        replay_cached_mcp_servers(&sessions, 42, &current, &viewer).await;
        assert!(messages.try_recv().is_err());
    }

    #[tokio::test]
    async fn mcp_payload_can_be_built_from_runtime_without_init_event() {
        let session = TestMcpSession::default();

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

        let read = mcp_servers_payload_from_runtime(&TestMcpSession::default(), 42).await;
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
