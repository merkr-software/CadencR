//! MCP status reports from live and retired runtimes.

use super::support::*;
use crate::domain::ws_session::runtime::detached_runtime::DetachedRuntime;
use std::time::Duration;

struct RefreshingMcpSession {
    observed: bool,
}

fn server(name: &str, status: &str) -> RuntimeMcpServerStatus {
    RuntimeMcpServerStatus {
        name: name.to_string(),
        status: status.to_string(),
    }
}

fn observed_servers(browser: &str, project: &str) -> Vec<RuntimeMcpServerStatus> {
    vec![
        server("cadencr-browser", browser),
        server("cadencr-project", project),
        server("external", "failed"),
    ]
}

#[async_trait::async_trait]
impl AgentRuntimeSession for RefreshingMcpSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }

    async fn session_id(&self) -> Option<String> {
        Some("refresh-session".to_string())
    }

    async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(if self.observed {
            observed_servers("connected", "configured")
        } else {
            vec![server("cached-server", "stale")]
        })
    }

    async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(if self.observed {
            observed_servers("connected", "configured")
        } else {
            vec![server("chrome-devtools", "connected")]
        })
    }

    async fn ended_mcp_servers(&self) -> Option<Vec<RuntimeMcpServerStatus>> {
        self.observed
            .then(|| observed_servers("disconnected", "disconnected"))
    }

    async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
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

    async fn set_permission_mode(&self, _mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

#[tokio::test]
async fn test_stream_reader_refreshes_mcp_servers_after_turn_result() {
    let app_state = make_test_app_state().await;
    let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let db_session_id = 79i64;
    let feature_id = 1i64;

    insert_running_session(&app_state, db_session_id, feature_id).await;
    sdk_sessions
        .lock()
        .await
        .insert(db_session_id, make_refreshing_mcp_handle(feature_id, false));

    let (msg_tx, msg_rx) = mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1);
    msg_tx
        .send(Ok(RuntimeEvent::new(
            crate::domain::agents::adapter::RuntimeEventMetadata::default(),
            RuntimeEventKind::Result,
        )))
        .await
        .unwrap();
    drop(msg_tx);

    spawn_test_stream_reader(
        &app_state,
        db_session_id,
        feature_id,
        msg_rx,
        ws_tx,
        sdk_sessions,
        "claude_code",
    );

    let payload = recv_mcp_servers_payload(&mut ws_rx).await;
    assert_eq!(payload["mcp_servers"][0]["name"], "chrome-devtools");
    assert_eq!(payload["mcp_servers"][0]["status"], "connected");
}

#[tokio::test]
async fn observed_mcp_servers_disconnect_on_runtime_eof_or_crash_but_stay_connected_between_turns()
{
    for crash in [false, true] {
        let mut fixture = ObservedRuntime::start().await;
        fixture.complete_turn().await;
        if crash {
            fixture
                .msg_tx
                .send(Err(RuntimeError::new("fixture runtime crashed")))
                .await
                .unwrap();
        }
        drop(fixture.msg_tx);

        let payload = recv_mcp_servers_payload(&mut fixture.ws_rx).await;
        assert_observed_statuses(&payload, "disconnected", "disconnected");
    }
}

#[tokio::test]
async fn explicitly_closing_a_detached_runtime_disconnects_its_observed_mcp_servers() {
    let mut fixture = ObservedRuntime::start().await;
    fixture.complete_turn().await;
    let detached = {
        let mut sessions = fixture.sdk_sessions.lock().await;
        let handle = sessions.get_mut(&ObservedRuntime::SESSION).unwrap();
        let query = handle.state.active_query().unwrap();
        let detached = DetachedRuntime::of(
            handle,
            query,
            ObservedRuntime::SESSION,
            &fixture.app_state.session_runtimes,
        );
        handle.state = QueryState::Pending(Default::default());
        detached
    };
    detached.close_in(&fixture.app_state).await;

    let payload = recv_mcp_servers_payload(&mut fixture.ws_rx).await;
    assert_observed_statuses(&payload, "disconnected", "disconnected");
}

#[tokio::test]
async fn superseded_reader_does_not_publish_a_terminal_snapshot_for_the_replacement() {
    let mut fixture = ObservedRuntime::start().await;
    fixture.complete_turn().await;
    fixture.sdk_sessions.lock().await.insert(
        ObservedRuntime::SESSION,
        make_refreshing_mcp_handle(ObservedRuntime::FEATURE, true),
    );
    fixture
        .app_state
        .ws_feature_senders
        .unregister_sender(&fixture.ws_tx)
        .await;
    drop(fixture.ws_tx);
    drop(fixture.msg_tx);

    // EOF on the viewer channel proves the old reader has processed its own EOF.
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(message) = fixture.ws_rx.recv().await {
            if let Message::Text(text) = message {
                let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
                assert_ne!(envelope.action, "mcp_servers");
            }
        }
    })
    .await
    .expect("superseded reader should stop");
    assert!(fixture.sdk_sessions.lock().await[&ObservedRuntime::SESSION]
        .state
        .active_query()
        .is_some());
}

struct ObservedRuntime {
    app_state: AppState,
    sdk_sessions: SdkSessions,
    msg_tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    ws_tx: WsSender,
    ws_rx: mpsc::UnboundedReceiver<Message>,
}

impl ObservedRuntime {
    const SESSION: i64 = 79;
    const FEATURE: i64 = 1;

    async fn start() -> Self {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, Self::SESSION, Self::FEATURE).await;
        let sdk_sessions: SdkSessions = Arc::new(Mutex::new(HashMap::from([(
            Self::SESSION,
            make_refreshing_mcp_handle(Self::FEATURE, true),
        )])));
        let (ws_tx, ws_rx) = mpsc::unbounded_channel();
        let (msg_tx, msg_rx) = mpsc::channel(1);
        app_state
            .ws_feature_senders
            .register(Self::FEATURE, ws_tx.clone())
            .await;
        spawn_test_stream_reader(
            &app_state,
            Self::SESSION,
            Self::FEATURE,
            msg_rx,
            ws_tx.clone(),
            sdk_sessions.clone(),
            "claude_code",
        );
        Self {
            app_state,
            sdk_sessions,
            msg_tx,
            ws_tx,
            ws_rx,
        }
    }

    async fn complete_turn(&mut self) {
        self.msg_tx
            .send(Ok(RuntimeEvent::new(
                Default::default(),
                RuntimeEventKind::Result,
            )))
            .await
            .unwrap();
        let payload = recv_mcp_servers_payload(&mut self.ws_rx).await;
        assert_observed_statuses(&payload, "connected", "configured");
    }
}

fn assert_observed_statuses(payload: &Value, browser: &str, project: &str) {
    assert_eq!(payload["session_id"], ObservedRuntime::SESSION.to_string());
    assert_eq!(
        payload["mcp_servers"],
        serde_json::json!([
            {"name": "cadencr-browser", "status": browser},
            {"name": "cadencr-project", "status": project},
            {"name": "external", "status": "failed"},
        ]),
    );
}

fn make_refreshing_mcp_handle(feature_id: i64, observed: bool) -> SdkHandle {
    let (permission_tx, _permission_rx) = session_prompt::permission_response_channel();
    SdkHandle {
        identity: crate::domain::ws_session::runtime::state::RuntimeHandleIdentity::default(),
        state: QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RefreshingMcpSession { observed }))),
            permission_tx,
        },
        feature_id,
        runtime_provider: "claude_code".to_string(),
        desired_model: Some("haiku".to_string()),
        spawned_model: Some("haiku".to_string()),
        desired_permission_mode: None,
        spawned_permission_mode: None,
        desired_access_mode: None,
        spawned_access_mode: None,
        desired_thinking_effort: None,
        spawned_thinking_effort: None,
        desired_claude_profile: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: None,
        config: SessionConfig {
            cwd: PathBuf::from("/tmp/test"),
            canonical_cwd: PathBuf::from("/tmp/test"),
            permission_mode: None,
            access_mode: None,
            thinking_effort: None,
            fast_mode: false,
            system_prompt: None,
            allow_bypass_permissions: false,
            claude_profile: None,
            env: None,
            env_unset: Vec::new(),
            overrides: Default::default(),
            runtime_overrides_dirty: false,
            profile_revision: None,
            profile_state_identity: None,
        },
        manual_compact_start: Default::default(),
        manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
    }
}

async fn recv_mcp_servers_payload(
    ws_rx: &mut mpsc::UnboundedReceiver<Message>,
) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(message) = ws_rx.recv().await {
            if let Message::Text(text) = message {
                let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
                if envelope.action == "mcp_servers" {
                    return envelope.payload;
                }
            }
        }
        panic!("viewer channel closed before the MCP snapshot");
    })
    .await
    .expect("timed out waiting for an MCP snapshot")
}
