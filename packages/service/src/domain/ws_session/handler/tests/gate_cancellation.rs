//! A reply already queued behind a question must outlive cancellation of that
//! question. Exercise the real queue persistence, worker and control dispatch.
use super::support::*;
use crate::domain::agents::adapter::{RuntimePermissionDecision, RuntimePermissionResponse};
use crate::domain::mcp::control::message_queue;
use crate::shared::migrate::{run_migrations, MigrationContext};
use tokio::sync::Notify;
use tokio::time::{timeout, Duration};

struct CancellingRuntime {
    turn_control: Arc<Mutex<()>>,
    interrupt_started: Arc<Notify>,
    finish_interrupt: Arc<Notify>,
    received: mpsc::UnboundedSender<Value>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for CancellingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        Some("claude-350".into())
    }
    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.received.send(content).unwrap();
        Ok(())
    }
    async fn respond_permission(
        &self,
        response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        assert!(matches!(response.decision, RuntimePermissionDecision::Deny));
        Ok(())
    }
    async fn turn_control_guard(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        Some(self.turn_control.clone().lock_owned().await)
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        self.interrupt_started.notify_one();
        self.finish_interrupt.notified().await;
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

async fn cancel_with_waiting_reply(automatic: bool) {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();
    let app_state = AppState::with_pool(pool.clone());
    let dir = tempfile::tempdir().unwrap();
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'QA', ?)")
        .bind(dir.path().to_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    for (id, title) in [(1, "parent"), (2, "child")] {
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (?, 1, ?)")
            .bind(id)
            .bind(title)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider) VALUES (?, ?, 'session', 'running', 'claude_code')")
            .bind(id).bind(id).execute(&pool).await.unwrap();
    }
    let gate = serde_json::json!({"request_id":"question-350", "tool_name":"AskUserQuestion", "tool_input":{"questions":[]}});
    sqlx::query("UPDATE agent_sessions SET pending_permission = ? WHERE id = 1")
        .bind(gate.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let interrupt_started = Arc::new(Notify::new());
    let finish_interrupt = Arc::new(Notify::new());
    let (received_tx, mut received_rx) = mpsc::unbounded_channel();
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(CancellingRuntime {
        turn_control: Default::default(),
        interrupt_started: interrupt_started.clone(),
        finish_interrupt: finish_interrupt.clone(),
        received: received_tx,
    })));
    let mut handle = make_active_handle(1, Some("claude-350".into()));
    handle.config.cwd = dir.path().to_path_buf();
    handle.config.canonical_cwd = dir.path().to_path_buf();
    handle.state = QueryState::Active {
        query,
        permission_tx: mpsc::channel(1).0,
    };
    let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
    app_state.active_turns.begin_turn(1, &sessions).await;
    app_state
        .session_runtimes
        .bind_feature(1, 1, &sessions)
        .await;
    let reply_uuid = uuid::Uuid::new_v4();
    if automatic {
        sqlx::raw_sql("INSERT INTO agent_messages (id, session_id, role, content, message_type) VALUES (1, 2, 'user', 'do QA', 'user_message'), (2, 2, 'assistant', 'AUTOREPLY350', 'text'); INSERT INTO agent_session_reply_waits (id, requester_session_id, responder_session_id, request_message_id, kind, status, armed_at) VALUES (1, 1, 2, 1, 'message', 'armed', datetime('now'));")
            .execute(&pool).await.unwrap();
    } else {
        message_queue::enqueue_message(
            &pool,
            1,
            Some(2),
            "<cadencr-reply>CHILD350</cadencr-reply>",
            reply_uuid,
        )
        .await
        .unwrap();
        message_queue::spawn(app_state.clone());
    }
    let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
    let state = app_state.clone();
    let close = tokio::spawn(async move {
        dispatch_envelope(
            make_envelope(
                "session",
                "gate.close",
                serde_json::json!({
                    "session_id":"1", "request_id":"question-350", "reason":"escape"
                }),
            ),
            &ws_tx,
            &sessions,
            &state,
        )
        .await;
    });
    timeout(Duration::from_secs(2), interrupt_started.notified())
        .await
        .unwrap();
    let auto_delivery = if automatic {
        let state = app_state.clone();
        Some(tokio::spawn(async move {
            crate::domain::mcp::control::reply_wait::deliver_completed(&state, 2)
                .await
                .unwrap()
        }))
    } else {
        // Wake the real background worker while the cancellation is in flight.
        message_queue::enqueue_message(
            &pool,
            1,
            Some(2),
            "<cadencr-reply>CHILD350</cadencr-reply>",
            reply_uuid,
        )
        .await
        .unwrap();
        None
    };
    assert!(
        timeout(Duration::from_millis(100), received_rx.recv())
            .await
            .is_err(),
        "child reply must not enter the turn being cancelled"
    );
    if !automatic {
        let pending: String = sqlx::query_scalar(
            "SELECT status FROM agent_session_message_queue WHERE target_session_id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pending, "pending");
    }
    assert!(
        ws_rx.try_recv().is_err(),
        "gate.closed must not advertise readiness before interruption finishes"
    );
    finish_interrupt.notify_one();
    timeout(Duration::from_secs(3), close)
        .await
        .unwrap()
        .unwrap();
    let reply = timeout(Duration::from_secs(3), received_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(reply.to_string().contains(if automatic {
        "AUTOREPLY350"
    } else {
        "CHILD350"
    }));
    if let Some(delivery) = auto_delivery {
        timeout(Duration::from_secs(3), delivery)
            .await
            .unwrap()
            .unwrap();
    }
    assert!(
        received_rx.try_recv().is_err(),
        "queued reply delivered exactly once"
    );
    if automatic {
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_reply_waits WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "delivered");
    } else {
        let delivery: (String, i64) = sqlx::query_as("SELECT status, attempt_count FROM agent_session_message_queue WHERE target_session_id = 1").fetch_one(&pool).await.unwrap();
        assert_eq!(delivery, ("delivered".into(), 1));
    }
}

#[tokio::test]
async fn reply_queued_during_question_is_delivered_only_after_cancel_finishes() {
    cancel_with_waiting_reply(false).await;
}

#[tokio::test]
async fn automatic_child_reply_waits_for_inflight_gate_cancellation() {
    cancel_with_waiting_reply(true).await;
}

struct FullTurnRuntime {
    prompt_started: Arc<Notify>,
    stop: Arc<Notify>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for FullTurnRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        None
    }
    async fn stream_input(&self, _: Value) -> Result<(), RuntimeError> {
        self.prompt_started.notify_one();
        self.stop.notified().await;
        Ok(())
    }
    async fn respond_permission(&self, _: RuntimePermissionResponse) -> Result<(), RuntimeError> {
        self.stop.notify_one();
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        self.stop.notify_one();
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

async fn full_turn_prompt_remains_cancellable(close_gate: bool) {
    let state = make_test_app_state().await;
    sqlx::raw_sql("CREATE TABLE agent_session_message_queue (id INTEGER, target_session_id INTEGER, status TEXT, error TEXT, claim_token TEXT, claimed_at TEXT, attempt_count INTEGER, source_session_id INTEGER, content TEXT, message_uuid TEXT);")
        .execute(&state.write_pool).await.unwrap();
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status, pending_permission) VALUES (1, 1, 'running', ?)")
        .bind(if close_gate { Some(serde_json::json!({"request_id":"full-turn", "tool_name":"AskUserQuestion", "tool_input":{}}).to_string()) } else { None })
        .execute(&state.write_pool).await.unwrap();
    let prompt_started = Arc::new(Notify::new());
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(FullTurnRuntime {
        prompt_started: prompt_started.clone(),
        stop: Arc::new(Notify::new()),
    })));
    let mut handle = make_in_place_effort_handle(1);
    handle.state = QueryState::Active {
        query: query.clone(),
        permission_tx: mpsc::channel(1).0,
    };
    let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
    state.active_turns.begin_turn(1, &sessions).await;
    state.session_runtimes.bind_feature(1, 1, &sessions).await;
    let prompt = tokio::spawn(async move {
        query
            .read()
            .await
            .stream_input(serde_json::json!("long ACP turn"))
            .await
            .unwrap()
    });
    timeout(Duration::from_secs(2), prompt_started.notified())
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    timeout(
        Duration::from_secs(2),
        dispatch_envelope(
            make_envelope(
                "session",
                if close_gate {
                    "gate.close"
                } else {
                    "interrupt"
                },
                serde_json::json!({"session_id":"1", "request_id":"full-turn", "reason":"escape"}),
            ),
            &tx,
            &sessions,
            &state,
        ),
    )
    .await
    .expect("controls must run while ACP-style prompt RPC is pending");
    timeout(Duration::from_secs(2), prompt)
        .await
        .unwrap()
        .unwrap();
    while let Ok(Message::Text(text)) = rx.try_recv() {
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_ne!(envelope.action, "error", "{text}");
    }
}

#[tokio::test]
async fn stop_can_interrupt_a_prompt_rpc_that_awaits_the_whole_turn() {
    full_turn_prompt_remains_cancellable(false).await;
}

#[tokio::test]
async fn gate_close_can_interrupt_a_prompt_rpc_that_awaits_the_whole_turn() {
    full_turn_prompt_remains_cancellable(true).await;
}

struct GuardOrderingRuntime {
    control: Arc<Mutex<()>>,
    first: std::sync::atomic::AtomicBool,
    events: mpsc::UnboundedSender<&'static str>,
    release_first_guard: Arc<Notify>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for GuardOrderingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        None
    }
    async fn stream_input(&self, _: Value) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn turn_control_guard(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        self.events.send("requested").unwrap();
        let guard = self.control.clone().lock_owned().await;
        if self.first.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.events.send("acquired").unwrap();
            self.release_first_guard.notified().await;
        }
        Some(guard)
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

#[tokio::test]
async fn followup_stop_and_queued_runtime_writer_do_not_deadlock() {
    let state = make_test_app_state().await;
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, status) VALUES (1, 1, 'running')")
        .execute(&state.write_pool)
        .await
        .unwrap();
    let (events, mut event_rx) = mpsc::unbounded_channel();
    let release = Arc::new(Notify::new());
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(GuardOrderingRuntime {
        control: Default::default(),
        first: AtomicBool::new(true),
        events,
        release_first_guard: release.clone(),
    })));
    let mut handle = make_active_handle(1, None);
    handle.state = QueryState::Active {
        query: query.clone(),
        permission_tx: mpsc::channel(1).0,
    };
    let sessions = Arc::new(Mutex::new(HashMap::from([(1, handle)])));
    state.active_turns.begin_turn(1, &sessions).await;
    state.session_runtimes.bind_feature(1, 1, &sessions).await;
    let prompt_state = state.clone();
    let prompt = tokio::spawn(async move {
        crate::domain::ws_session::runtime::application::dispatch_control_prompt(
            &prompt_state,
            1,
            1,
            "steer during turn",
            true,
        )
        .await
        .unwrap()
    });
    assert_eq!(
        timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap(),
        Some("requested")
    );
    assert_eq!(
        timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap(),
        Some("acquired")
    );
    let stop_state = state.clone();
    let stop = tokio::spawn(async move {
        let (tx, _rx) = mpsc::unbounded_channel();
        dispatch_envelope(
            make_envelope(
                "session",
                "interrupt",
                serde_json::json!({"session_id":"1"}),
            ),
            &tx,
            &sessions,
            &stop_state,
        )
        .await;
    });
    assert_eq!(
        timeout(Duration::from_secs(2), event_rx.recv())
            .await
            .unwrap(),
        Some("requested")
    );
    let writer_queued = Arc::new(Notify::new());
    let queued = writer_queued.clone();
    let writer = tokio::spawn(async move {
        queued.notify_one();
        let _runtime = query.write().await;
    });
    writer_queued.notified().await;
    release.notify_one();
    timeout(Duration::from_secs(2), async { prompt.await.unwrap(); stop.await.unwrap(); writer.await.unwrap(); }).await.expect("dispatch must not reacquire a read lock behind a queued writer while holding the turn barrier");
}
