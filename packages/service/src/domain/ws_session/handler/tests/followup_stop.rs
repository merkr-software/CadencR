//! A user Stop cancels the follow-ups the agent has not taken in yet (see
//! `runtime::followup_stops`); a prompt sent while nothing runs is no
//! follow-up and goes through.

use super::super::session_control::stop_session;
use super::support::*;
use crate::domain::agents::adapter::WithdrawnInputs;

/// A runtime whose turn barrier the test holds, recording what it is handed
/// and which follow-ups it is asked to withdraw (it withdraws them all).
struct StopAwareSession {
    streamed: mpsc::UnboundedSender<Value>,
    barrier: Arc<tokio::sync::Mutex<()>>,
    withdraw_asked: Arc<std::sync::Mutex<Vec<String>>>,
    /// Drop every input as a runtime does that saw the Stop first.
    withdraws_inputs: bool,
    /// Keep what it was handed at a Stop, as Codex keeps an accepted steer.
    keeps_inputs: bool,
    message_rx: Option<RuntimeMessageRx>,
}

#[async_trait::async_trait]
impl AgentRuntimeSession for StopAwareSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        self.message_rx.take().unwrap()
    }
    async fn session_id(&self) -> Option<String> {
        Some("runtime-session".to_string())
    }
    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        if self.withdraws_inputs {
            return Err(RuntimeError::input_withdrawn("the turn was stopped first"));
        }
        self.streamed.send(content).unwrap();
        Ok(())
    }
    async fn turn_control_guard(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        Some(self.barrier.clone().lock_owned().await)
    }
    async fn withdraw_pending_inputs(&self, ids: &[String]) -> WithdrawnInputs {
        self.withdraw_asked
            .lock()
            .unwrap()
            .extend(ids.iter().cloned());
        WithdrawnInputs {
            withdrawn: if self.keeps_inputs {
                Vec::new()
            } else {
                ids.to_vec()
            },
            error: None,
        }
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

struct Fixture {
    app_state: AppState,
    sessions: SdkSessions,
    tx: WsSender,
    db_id: i64,
    session_id: String,
    streamed: mpsc::UnboundedReceiver<Value>,
    barrier: Arc<tokio::sync::Mutex<()>>,
    withdraw_asked: Arc<std::sync::Mutex<Vec<String>>>,
}

const FOLLOW_UP: &str = "5b0b0c1e-8d3f-4a59-9a43-2f4f3d1f9a10";

/// A live runtime; `turn_running` says whether a turn runs on it.
async fn fixture(turn_running: bool) -> Fixture {
    fixture_with(turn_running, false).await
}

async fn fixture_with(turn_running: bool, withdraws_inputs: bool) -> Fixture {
    fixture_full(turn_running, withdraws_inputs, false).await
}

async fn fixture_full(turn_running: bool, withdraws_inputs: bool, keeps_inputs: bool) -> Fixture {
    let app_state = make_test_app_state().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sessions: SdkSessions = Arc::new(Mutex::new(HashMap::new()));
    let session_id = init_session(&tx, &mut rx, &sessions, &app_state, 1).await;
    let db_id: i64 = session_id.parse().unwrap();
    let (streamed_tx, streamed) = mpsc::unbounded_channel();
    let barrier = Arc::new(tokio::sync::Mutex::new(()));
    let withdraw_asked = Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let mut handles = sessions.lock().await;
        let handle = handles.get_mut(&db_id).unwrap();
        let (permission_tx, _permission_rx) = session_prompt::permission_response_channel();
        let (_message_tx, message_rx) = mpsc::channel(1);
        handle.state = QueryState::Active {
            query: Arc::new(RwLock::new(Box::new(StopAwareSession {
                streamed: streamed_tx,
                barrier: barrier.clone(),
                withdraw_asked: withdraw_asked.clone(),
                withdraws_inputs,
                keeps_inputs,
                message_rx: Some(message_rx),
            }))),
            permission_tx,
        };
        handle.spawned_model = handle.desired_model.clone();
        handle.spawned_permission_mode = handle.desired_permission_mode.clone();
        handle.spawned_access_mode = handle.desired_access_mode.clone();
        handle.spawned_thinking_effort = handle.desired_thinking_effort.clone();
        handle.spawned_claude_profile = handle.desired_claude_profile.clone();
    }
    app_state.active_turns.begin_turn(db_id, &sessions).await;
    if turn_running {
        app_state.session_status_tx.broadcast_running(db_id, 1);
    }
    Fixture {
        app_state,
        sessions,
        tx,
        db_id,
        session_id,
        streamed,
        barrier,
        withdraw_asked,
    }
}

impl Fixture {
    /// Send a follow-up while the test holds the turn barrier, and wait until
    /// it is accepted (persisted) and waits at that barrier.
    async fn send_held_follow_up(&self) -> tokio::task::JoinHandle<()> {
        self.send_follow_up(true).await
    }

    /// `track`: whether the client asks for the agent's receipt.
    async fn send_follow_up(&self, track: bool) -> tokio::task::JoinHandle<()> {
        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": self.session_id,
                "text": "and the docs too",
                "message_uuid": FOLLOW_UP,
                "track_prompt_receipt": track,
            }),
        );
        let (tx, sessions, app_state) = (
            self.tx.clone(),
            self.sessions.clone(),
            self.app_state.clone(),
        );
        let dispatch = tokio::spawn(async move {
            dispatch_envelope(envelope, &tx, &sessions, &app_state).await;
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while self.delivery_state().await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the follow-up is persisted");
        dispatch
    }

    /// What the stopped turn's end does with what its Stop left.
    async fn settle(&self, unwithdrawn: Vec<String>) {
        crate::domain::ws_session::runtime::prompt::followup_withdrawal::fail_stopped_followups(
            &self.app_state.write_pool,
            &self.app_state.ws_feature_senders,
            1,
            self.db_id,
            unwithdrawn,
        )
        .await;
    }

    async fn dispatch_status(&self) -> String {
        sqlx::query_scalar(
            "SELECT d.status FROM agent_message_dispatches d
             JOIN agent_messages m ON m.id = d.message_id
             WHERE m.session_id = ? AND m.message_uuid = ?",
        )
        .bind(self.db_id)
        .bind(FOLLOW_UP)
        .fetch_one(&self.app_state.write_pool)
        .await
        .unwrap()
    }

    /// `Some(state)` once the follow-up row exists (`"none"` for no state).
    async fn delivery_state(&self) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT delivery_state FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
        )
        .bind(self.db_id)
        .bind(FOLLOW_UP)
        .fetch_optional(&self.app_state.write_pool)
        .await
        .unwrap()
        .map(|state| state.unwrap_or_else(|| "none".to_string()))
    }
}

#[tokio::test]
async fn a_stop_before_the_hand_over_cancels_the_follow_up() {
    let mut fixture = fixture(true).await;
    let held = fixture.barrier.clone().lock_owned().await;
    let dispatch = fixture.send_held_follow_up().await;

    fixture
        .app_state
        .active_turns
        .followups()
        .record_stop(fixture.db_id);
    drop(held);
    dispatch.await.unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while fixture.delivery_state().await.as_deref() != Some("delivery_failed") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the cancelled follow-up reads as not delivered");
    assert!(
        fixture.streamed.try_recv().is_err(),
        "the runtime never got it"
    );
}

#[tokio::test]
async fn a_stop_after_the_hand_over_withdraws_the_follow_up_from_the_runtime() {
    let mut fixture = fixture(true).await;
    fixture.send_held_follow_up().await.await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the follow-up reaches the runtime");

    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();

    assert_eq!(
        *fixture.withdraw_asked.lock().unwrap(),
        vec![FOLLOW_UP.to_string()]
    );
    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("delivery_failed")
    );
}

/// A prompt sent while nothing runs starts the turn: the Stop stops that turn.
#[tokio::test]
async fn a_prompt_sent_while_idle_is_not_cancelled_by_a_stop() {
    let mut fixture = fixture(false).await;
    let held = fixture.barrier.clone().lock_owned().await;
    let dispatch = fixture.send_held_follow_up().await;

    fixture
        .app_state
        .active_turns
        .followups()
        .record_stop(fixture.db_id);
    drop(held);
    dispatch.await.unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the prompt still reaches the runtime");
    assert_ne!(
        fixture.delivery_state().await.as_deref(),
        Some("delivery_failed")
    );
}

async fn wait_for_failed(fixture: &Fixture) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while fixture.delivery_state().await.as_deref() != Some("delivery_failed") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the cancelled follow-up reads as not delivered");
}

/// The stopped turn ended while the follow-up waited: it must not mark the
/// session working again, since no turn would ever end that.
#[tokio::test]
async fn a_follow_up_cancelled_after_the_turn_ended_leaves_the_session_idle() {
    let fixture = fixture(true).await;
    let held = fixture.barrier.clone().lock_owned().await;
    let dispatch = fixture.send_held_follow_up().await;

    fixture
        .app_state
        .active_turns
        .followups()
        .record_stop(fixture.db_id);
    fixture.app_state.session_status_tx.broadcast(
        fixture.db_id,
        1,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );
    drop(held);
    dispatch.await.unwrap();

    wait_for_failed(&fixture).await;
    assert!(!fixture.app_state.session_status_tx.is_busy(fixture.db_id));
}

/// A prompt sent while idle that the runtime dropped for a Stop (ACP drops
/// one still waiting for the stopped turn) started the only turn: nothing
/// else ends it, so the session ends idle.
#[tokio::test]
async fn a_prompt_the_runtime_dropped_ends_its_turn_idle() {
    let fixture = fixture_with(false, true).await;
    fixture.send_held_follow_up().await.await.unwrap();

    wait_for_failed(&fixture).await;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while fixture.app_state.session_status_tx.is_busy(fixture.db_id) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the session ends idle");
}

/// Found live: the withdrawn follow-up's dispatch still read as done, so its
/// Retry was taken for a duplicate and never reached the agent.
#[tokio::test]
async fn a_retry_sends_a_withdrawn_follow_up_again() {
    let mut fixture = fixture(true).await;
    fixture.send_held_follow_up().await.await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the follow-up reaches the runtime");
    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();
    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("delivery_failed")
    );

    // Sent while idle, as the desktop does: untracked, yet tracked as a retry.
    fixture.send_follow_up(false).await.await.unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the retry reaches the runtime");
    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("pending_agent"),
        "pending again, until the agent's receipt"
    );
}

/// A runtime that keeps an accepted follow-up (Codex) leaves it to the
/// stopped turn's end, which reads it as not delivered unless acknowledged.
#[tokio::test]
async fn a_follow_up_the_runtime_kept_waits_for_the_stopped_turn() {
    let mut fixture = fixture_full(true, false, true).await;
    fixture.send_held_follow_up().await.await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the follow-up reaches the runtime");

    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();
    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("pending_agent")
    );

    let unwithdrawn = fixture
        .app_state
        .active_turns
        .followups()
        .turn_ended(fixture.db_id);
    assert_eq!(unwithdrawn, vec![FOLLOW_UP.to_string()]);
    fixture.settle(unwithdrawn).await;
    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("delivery_failed")
    );
    assert_eq!(
        fixture.dispatch_status().await,
        "error",
        "a retry may send it again"
    );
    assert!(
        !crate::domain::sessions::user_messages::update_delivery_state(
            &fixture.app_state.write_pool,
            fixture.db_id,
            FOLLOW_UP,
            "received_agent",
        )
        .await
        .unwrap(),
        "a receipt after the stopped turn does not count"
    );
}

/// One the stopped turn acknowledged before it ended was taken in by it.
#[tokio::test]
async fn a_follow_up_acknowledged_before_the_stopped_turn_ended_stays_received() {
    let mut fixture = fixture_full(true, false, true).await;
    fixture.send_held_follow_up().await.await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the follow-up reaches the runtime");
    stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
        .await
        .unwrap();
    crate::domain::sessions::user_messages::update_delivery_state(
        &fixture.app_state.write_pool,
        fixture.db_id,
        FOLLOW_UP,
        "received_agent",
    )
    .await
    .unwrap();

    let unwithdrawn = fixture
        .app_state
        .active_turns
        .followups()
        .turn_ended(fixture.db_id);
    fixture.settle(unwithdrawn).await;

    assert_eq!(
        fixture.delivery_state().await.as_deref(),
        Some("received_agent")
    );
}
