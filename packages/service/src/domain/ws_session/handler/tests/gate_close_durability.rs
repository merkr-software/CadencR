//! Closing a gate saves the close before touching the runtime: a close that
//! cannot be saved leaves the agent and its open request as they were, and a
//! runtime that refuses the close gets its gate back.

use super::support::*;
use crate::domain::agents::adapter::RuntimePermissionResponse;
use std::sync::atomic::{AtomicUsize, Ordering};

const SESSION: i64 = 41;
const REQUEST: &str = "question-41";

/// Counts every way a gate close can reach the runtime.
#[derive(Default)]
struct Touches {
    dismissed: AtomicUsize,
    denied: AtomicUsize,
    interrupted: AtomicUsize,
}

impl Touches {
    fn total(&self) -> usize {
        self.dismissed.load(Ordering::SeqCst)
            + self.denied.load(Ordering::SeqCst)
            + self.interrupted.load(Ordering::SeqCst)
    }
}

struct CountingRuntime {
    touches: Arc<Touches>,
    refuse_interrupt: bool,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for CountingRuntime {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        mpsc::channel(1).1
    }
    async fn session_id(&self) -> Option<String> {
        Some("codex-41".into())
    }
    async fn stream_input(&self, _: Value) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn dismiss_nonblocking_request(&self, _: &str) -> Result<bool, RuntimeError> {
        self.touches.dismissed.fetch_add(1, Ordering::SeqCst);
        Ok(false)
    }
    async fn respond_permission(&self, _: RuntimePermissionResponse) -> Result<(), RuntimeError> {
        self.touches.denied.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), RuntimeError> {
        self.touches.interrupted.fetch_add(1, Ordering::SeqCst);
        if self.refuse_interrupt {
            return Err(RuntimeError::new("the CLI refused the interrupt"));
        }
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

async fn question_session(refuse_interrupt: bool) -> (AppState, SdkSessions, Arc<Touches>) {
    let app_state = make_test_app_state().await;
    let question = serde_json::json!({
        "request_id": REQUEST,
        "tool_name": "AskUserQuestion",
        "tool_input": { "questions": [] }
    });
    sqlx::query(
        "INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider, pending_questions) \
         VALUES (?, 1, 'session', 'running', 'codex_cli', ?)",
    )
    .bind(SESSION)
    .bind(question.to_string())
    .execute(&app_state.write_pool)
    .await
    .unwrap();
    let touches = Arc::new(Touches::default());
    let mut handle = make_active_handle(1, Some("codex-41".into()));
    handle.runtime_provider = "codex_cli".into();
    handle.state = QueryState::Active {
        query: Arc::new(RwLock::new(Box::new(CountingRuntime {
            touches: touches.clone(),
            refuse_interrupt,
        }))),
        permission_tx: crate::domain::ws_session::runtime::prompt::permission_response_channel().0,
    };
    let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::from([(SESSION, handle)])));
    app_state.active_turns.begin_turn(SESSION, &sessions).await;
    (app_state, sessions, touches)
}

async fn close_gate(app_state: &AppState, sessions: &SdkSessions) -> WsEnvelope {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let envelope = make_envelope(
        "session",
        "gate.close",
        serde_json::json!({
            "session_id": SESSION.to_string(), "request_id": REQUEST, "reason": "escape"
        }),
    );
    dispatch_envelope(envelope, &tx, sessions, app_state).await;
    let Message::Text(text) = rx.try_recv().expect("a reply to the close") else {
        panic!("expected a text envelope");
    };
    serde_json::from_str(&text).unwrap()
}

async fn question_stored(app_state: &AppState) -> bool {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT pending_questions FROM agent_sessions WHERE id = ?",
    )
    .bind(SESSION)
    .fetch_one(&app_state.read_pool)
    .await
    .unwrap()
    .is_some()
}

/// It used to deny and interrupt the agent first, then fail to save: the
/// question vanished from the conversation, came back on reload, and could no
/// longer be answered.
#[tokio::test]
async fn a_close_that_cannot_be_saved_leaves_the_agent_and_the_gate_untouched() {
    let (app_state, sessions, touches) = question_session(false).await;
    sqlx::query(
        "CREATE TRIGGER refuse_gate_clear BEFORE UPDATE OF pending_questions ON agent_sessions \
         BEGIN SELECT RAISE(FAIL, 'gate storage unavailable'); END",
    )
    .execute(&app_state.write_pool)
    .await
    .unwrap();

    let reply = close_gate(&app_state, &sessions).await;

    assert_eq!(reply.action, "error");
    assert_eq!(reply.payload["code"], "DB_ERROR");
    assert_eq!(touches.total(), 0, "the runtime must not be touched");
    assert!(question_stored(&app_state).await);
    // The claim was released: the gate can still be closed or answered.
    assert!(app_state
        .pending_gates
        .claim(SESSION, REQUEST)
        .await
        .is_ok());
}

#[tokio::test]
async fn a_runtime_that_refuses_the_close_gets_its_gate_back() {
    let (app_state, sessions, touches) = question_session(true).await;

    let reply = close_gate(&app_state, &sessions).await;

    assert_eq!(reply.action, "error");
    assert_eq!(reply.payload["code"], "SDK_ERROR");
    assert_eq!(touches.interrupted.load(Ordering::SeqCst), 1);
    assert!(question_stored(&app_state).await);
}

#[tokio::test]
async fn a_saved_close_stops_the_turn_and_clears_the_gate() {
    let (app_state, sessions, touches) = question_session(false).await;

    let reply = close_gate(&app_state, &sessions).await;

    assert_eq!(reply.action, "gate.closed", "{reply:?}");
    assert_eq!(touches.interrupted.load(Ordering::SeqCst), 1);
    assert!(!question_stored(&app_state).await);
}

/// A close sent for a gate that is gone (answered over the API while a
/// queued prompt then started) used to stop the turn that runs now.
#[tokio::test]
async fn a_stale_close_never_stops_the_running_turn() {
    let (app_state, sessions, touches) = question_session(false).await;
    sqlx::query("UPDATE agent_sessions SET pending_questions = NULL WHERE id = ?")
        .bind(SESSION)
        .execute(&app_state.write_pool)
        .await
        .unwrap();

    let reply = close_gate(&app_state, &sessions).await;

    assert_eq!(reply.action, "error");
    assert_eq!(reply.payload["code"], "STALE_GATE");
    assert_eq!(touches.total(), 0, "the running turn is left alone");
}

/// The close that stops the turn asks for the queue to go on once that turn
/// ends; delivering then, while the turn still ran, never delivered anything.
#[tokio::test]
async fn a_close_that_stops_the_turn_lets_the_queue_go_on_after_it() {
    let (app_state, sessions, _touches) = question_session(false).await;

    close_gate(&app_state, &sessions).await;

    assert!(
        app_state
            .active_turns
            .take_queue_after_stop(SESSION, 1)
            .await,
        "the stopped turn's end delivers the next queued prompt"
    );
}
