//! MCP refresh behavior for the WebSocket stream reader.

use super::support::*;

struct RefreshingMcpSession;

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
        Ok(vec![RuntimeMcpServerStatus {
            name: "cached-server".to_string(),
            status: "stale".to_string(),
        }])
    }

    async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(vec![RuntimeMcpServerStatus {
            name: "chrome-devtools".to_string(),
            status: "connected".to_string(),
        }])
    }

    async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
        Ok(())
    }

    async fn interrupt(&self) -> Result<(), RuntimeError> {
        Ok(())
    }

    async fn close(&mut self) {}

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

    sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status) VALUES (?, ?, 'session', 'running')")
        .bind(db_session_id)
        .bind(feature_id)
        .execute(&app_state.write_pool)
        .await
        .unwrap();
    sdk_sessions
        .lock()
        .await
        .insert(db_session_id, make_refreshing_mcp_handle(feature_id));

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

fn make_refreshing_mcp_handle(feature_id: i64) -> SdkHandle {
    let (permission_tx, _permission_rx) = mpsc::channel::<session_prompt::PermissionResponse>(1);
    SdkHandle {
        state: QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RefreshingMcpSession))),
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
            system_prompt: None,
            allow_bypass_permissions: false,
            claude_profile: None,
            env: None,
        },
        manual_compact_cancel: Arc::new(AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(AtomicBool::new(false)),
    }
}

async fn recv_mcp_servers_payload(
    ws_rx: &mut mpsc::UnboundedReceiver<Message>,
) -> serde_json::Value {
    loop {
        let Some(Message::Text(text)) = ws_rx.recv().await else {
            continue;
        };
        let env: WsEnvelope = serde_json::from_str(&text).unwrap();
        if env.action == "mcp_servers" {
            return env.payload;
        }
    }
}
