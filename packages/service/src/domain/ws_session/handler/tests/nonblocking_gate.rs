//! A question the agent asked without blocking (Codex `request_user_input_async`)
//! closes without stopping the agent, and a Stop between turns leaves no stop
//! mark for the next turn's result to consume.
use super::super::stop_session;
use super::support::*;
use crate::domain::gate_registry::{GateKind, PendingGate};
use crate::domain::session_status::{AgentStatus, PendingKind};
use std::sync::atomic::{AtomicUsize, Ordering};

const SESSION: i64 = 61;
const QUESTION: &str = "codex_async_question_call_qa";

struct NonBlockingRuntime {
    nonblocking: bool,
    interrupts: Arc<AtomicUsize>,
    dismissed: mpsc::UnboundedSender<String>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for NonBlockingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        Some("thread-61".into())
    }
    async fn stream_input(&self, _: Value) -> Result<(), RuntimeError> {
        panic!("closing a question sends the agent nothing");
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn dismiss_nonblocking_request(&self, request_id: &str) -> Result<bool, RuntimeError> {
        self.dismissed.send(request_id.to_string()).unwrap();
        Ok(self.nonblocking)
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

struct Fixture {
    app_state: AppState,
    sessions: SdkSessions,
    query: RuntimeSessionHandle,
    interrupts: Arc<AtomicUsize>,
    dismissed: mpsc::UnboundedReceiver<String>,
}

/// A live runtime between or during turns (`status`), with the question
/// persisted and shown as the session's pending gate.
async fn fixture(status: &str, nonblocking: bool) -> Fixture {
    let app_state = make_test_app_state().await;
    // Closing a question that ended its wait drains the reply queue.
    sqlx::raw_sql("CREATE TABLE agent_session_message_queue (id INTEGER, target_session_id INTEGER, status TEXT, error TEXT, claim_token TEXT, claimed_at TEXT, attempt_count INTEGER, source_session_id INTEGER, content TEXT, message_uuid TEXT);")
        .execute(&app_state.write_pool)
        .await
        .unwrap();
    let gate = serde_json::json!({
        "request_id": QUESTION, "tool_name": "AskUserQuestion",
        "tool_input": {"questions": [{"question": "Open the QA instance?"}]}
    });
    sqlx::query("INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider, pending_questions) VALUES (?, 1, 'session', ?, 'codex_cli', ?)")
        .bind(SESSION)
        .bind(status)
        .bind(gate.to_string())
        .execute(&app_state.write_pool)
        .await
        .unwrap();
    let interrupts = Arc::new(AtomicUsize::new(0));
    let (dismissed_tx, dismissed) = mpsc::unbounded_channel();
    let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(NonBlockingRuntime {
        nonblocking,
        interrupts: interrupts.clone(),
        dismissed: dismissed_tx,
    })));
    let mut handle = make_active_handle(1, Some("thread-61".into()));
    handle.state = QueryState::Active {
        query: query.clone(),
        permission_tx: crate::domain::ws_session::runtime::prompt::permission_response_channel().0,
    };
    let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::from([(SESSION, handle)])));
    app_state.active_turns.begin_turn(SESSION, &sessions).await;
    app_state.session_status_tx.broadcast_running(SESSION, 1);
    app_state.session_status_tx.broadcast_gate(
        SESSION,
        1,
        PendingKind::Question,
        QUESTION.to_string(),
    );
    Fixture {
        app_state,
        sessions,
        query,
        interrupts,
        dismissed,
    }
}

/// Close the question; every frame the server answered with.
async fn close_question(fixture: &Fixture) -> Vec<WsEnvelope> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let envelope = make_envelope(
        "session",
        "gate.close",
        serde_json::json!({"session_id": SESSION.to_string(), "request_id": QUESTION, "reason": "escape"}),
    );
    dispatch_envelope(envelope, &tx, &fixture.sessions, &fixture.app_state).await;
    drop(tx);
    let mut frames = Vec::new();
    while let Some(Message::Text(text)) = rx.recv().await {
        frames.push(serde_json::from_str(&text).unwrap());
    }
    frames
}

fn only_gate_closed(frames: &[WsEnvelope]) {
    let actions: Vec<_> = frames.iter().map(|frame| frame.action.as_str()).collect();
    assert_eq!(actions, ["gate.closed"], "{frames:?}");
}

async fn pending_questions(app_state: &AppState) -> Option<String> {
    sqlx::query_scalar("SELECT pending_questions FROM agent_sessions WHERE id = ?")
        .bind(SESSION)
        .fetch_one(&app_state.read_pool)
        .await
        .unwrap()
}

fn shown_status(app_state: &AppState) -> Option<AgentStatus> {
    let snapshot = app_state.session_status_tx.snapshot();
    snapshot
        .states
        .get(&SESSION.to_string())
        .map(|entry| entry.status)
}

async fn has_stop_mark(fixture: &Fixture) -> bool {
    fixture
        .app_state
        .active_turns
        .take_interruption(SESSION, &Arc::downgrade(&fixture.query))
        .await
        .is_some()
}

#[tokio::test]
async fn closing_a_question_left_after_the_turn_ended_leaves_the_session_idle() {
    let mut fixture = fixture("completed", true).await;

    only_gate_closed(&close_question(&fixture).await);

    assert_eq!(fixture.dismissed.recv().await.unwrap(), QUESTION);
    assert!(pending_questions(&fixture.app_state).await.is_none());
    assert_eq!(fixture.interrupts.load(Ordering::SeqCst), 0);
    assert!(
        !has_stop_mark(&fixture).await,
        "no mark for the next turn's result"
    );
    assert_eq!(
        shown_status(&fixture.app_state),
        None,
        "idle sessions leave the book"
    );
}

#[tokio::test]
async fn closing_a_question_asked_mid_turn_lets_the_agent_work_on() {
    let fixture = fixture("running", true).await;

    only_gate_closed(&close_question(&fixture).await);

    assert!(pending_questions(&fixture.app_state).await.is_none());
    assert_eq!(fixture.interrupts.load(Ordering::SeqCst), 0);
    assert_eq!(shown_status(&fixture.app_state), Some(AgentStatus::Agent));
}

#[tokio::test]
async fn closing_a_blocking_question_still_stops_the_turn() {
    let fixture = fixture("running", false).await;

    only_gate_closed(&close_question(&fixture).await);

    assert!(pending_questions(&fixture.app_state).await.is_none());
    assert_eq!(fixture.interrupts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stop_with_only_a_question_left_after_the_turn_interrupts_nothing() {
    let fixture = fixture("completed", true).await;

    let error = stop_session(&fixture.app_state, Some(&fixture.sessions), SESSION)
        .await
        .unwrap_err();

    assert_eq!(error.code, super::super::NOTHING_TO_STOP);
    assert_eq!(fixture.interrupts.load(Ordering::SeqCst), 0);
    assert!(!has_stop_mark(&fixture).await);
}

#[tokio::test]
async fn closing_a_question_keeps_showing_a_gate_raised_before_it() {
    let fixture = fixture("running", true).await;
    let approval =
        serde_json::json!({"request_id": "approval", "tool_name": "Bash", "tool_input": {}});
    sqlx::query("UPDATE agent_sessions SET pending_permission = ? WHERE id = ?")
        .bind(approval.to_string())
        .bind(SESSION)
        .execute(&fixture.app_state.write_pool)
        .await
        .unwrap();
    // The runtime registers each gate it raises; both are open.
    for (request_id, kind) in [
        ("approval", GateKind::Permission),
        (QUESTION, GateKind::Question),
    ] {
        fixture
            .app_state
            .pending_gates
            .register(
                SESSION,
                PendingGate {
                    request_id: request_id.into(),
                    kind,
                    payload: Value::Null,
                },
            )
            .await;
    }

    only_gate_closed(&close_question(&fixture).await);

    assert!(pending_questions(&fixture.app_state).await.is_none());
    let snapshot = fixture.app_state.session_status_tx.snapshot();
    let pending = &snapshot.states[&SESSION.to_string()];
    assert_eq!(pending.status, AgentStatus::Question);
    assert_eq!(pending.kind, Some(PendingKind::Permission));
    assert_eq!(pending.request_id.as_deref(), Some("approval"));
}

#[tokio::test]
async fn a_turn_started_meanwhile_is_not_reported_idle() {
    let fixture = fixture("completed", true).await;
    // A reply from another device started a turn before the close landed.
    fixture
        .app_state
        .session_status_tx
        .broadcast_running(SESSION, 1);

    only_gate_closed(&close_question(&fixture).await);

    assert!(pending_questions(&fixture.app_state).await.is_none());
    assert_eq!(shown_status(&fixture.app_state), Some(AgentStatus::Agent));
}

#[tokio::test]
async fn stop_during_a_turn_showing_a_question_still_interrupts() {
    let fixture = fixture("running", true).await;

    stop_session(&fixture.app_state, Some(&fixture.sessions), SESSION)
        .await
        .unwrap();

    assert_eq!(fixture.interrupts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn closing_a_question_answered_by_a_plain_reply_leaves_the_session_idle() {
    let mut fixture = fixture("completed", true).await;
    let status = &fixture.app_state.session_status_tx;
    // The user replied with a prompt instead of the form; that turn ended
    // with the question still pending.
    status.broadcast_running(SESSION, 1);
    status.broadcast_gate_left_pending(SESSION, 1, PendingKind::Question, QUESTION.into());
    assert_eq!(
        shown_status(&fixture.app_state),
        Some(AgentStatus::Question)
    );

    only_gate_closed(&close_question(&fixture).await);

    assert_eq!(fixture.dismissed.recv().await.unwrap(), QUESTION);
    assert_eq!(shown_status(&fixture.app_state), None);
    assert!(!has_stop_mark(&fixture).await);
}
