//! A queued command must recheck Pending after the first launcher registers
//! its runtime, rather than panic, consume a second spawn, or drop the prompt.
use super::support::*;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::ws_session::runtime::application::dispatch_control_prompt;
use tokio::time::{timeout, Duration};

struct RecordingRuntime {
    delivered: mpsc::UnboundedSender<Value>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for RecordingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        None
    }
    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.delivered.send(content).unwrap();
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn close(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_model(&self, _: &str) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn set_permission_mode(&self, _: RuntimePermissionMode) -> Result<(), RuntimeError> {
        Ok(())
    }
    fn pid(&self) -> Option<u32> {
        None
    }
}

async fn queued_prompt_after_first_launch(headless: bool) {
    let state = make_test_app_state().await;
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status, runtime_provider, model) VALUES (1, 1, 'running', 'opencode', 'openai/gpt-5.4')")
        .execute(&state.write_pool).await.unwrap();
    let mut handle = make_in_place_effort_handle(1);
    handle.state = QueryState::Pending(RuntimeSpawnConfig {
        cwd: "/tmp/test".into(),
        model: handle.desired_model.clone(),
        ..Default::default()
    });
    handle.spawned_model = None;
    let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
    state.session_runtimes.bind_feature(1, 1, &sessions).await;
    // The first prompt owns launch while its adapter is starting. Hold that
    // exact claim and install its accepted runtime at a deterministic boundary.
    let launch = state.session_runtimes.claim_spawn(1).await;
    let prompt_state = state.clone();
    let prompt_sessions = sessions.clone();
    let mut queued = tokio::spawn(async move {
        if headless {
            dispatch_control_prompt(&prompt_state, 1, 1, "queued text", false)
                .await
                .unwrap()
                .delivery_confirmed();
        } else {
            let (sender, _receiver) = mpsc::unbounded_channel();
            dispatch_envelope(make_envelope("session", "prompt.send", serde_json::json!({
                "session_id": "1", "text": "queued text", "message_uuid": uuid::Uuid::new_v4().to_string()
            })), &sender, &prompt_sessions, &prompt_state).await;
        }
    });
    assert!(
        timeout(Duration::from_millis(50), &mut queued)
            .await
            .is_err(),
        "second command must wait for the launcher"
    );
    let (delivered, mut deliveries) = mpsc::unbounded_channel();
    {
        let mut guard = sessions.lock().await;
        let handle = guard.get_mut(&1).unwrap();
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(RecordingRuntime { delivered }))),
            permission_tx: mpsc::channel(1).0,
        };
        handle.spawned_model = handle.desired_model.clone();
    }
    drop(launch);
    timeout(Duration::from_secs(2), &mut queued)
        .await
        .unwrap()
        .unwrap();
    let content = timeout(Duration::from_secs(2), deliveries.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(content.to_string().contains("queued text"));
    assert!(deliveries.try_recv().is_err());
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_messages WHERE session_id = 1 AND role = 'user'",
    )
    .fetch_one(&state.read_pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "only one canonical user message is persisted");
}

#[tokio::test]
async fn websocket_prompt_waiting_for_first_launch_routes_to_new_active_runtime() {
    queued_prompt_after_first_launch(false).await;
}

#[tokio::test]
async fn headless_prompt_waiting_for_websocket_launch_routes_to_new_active_runtime() {
    queued_prompt_after_first_launch(true).await;
}
