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
    reject_after: Arc<std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>>,
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
        let reject_after = self.reject_after.lock().unwrap().take();
        if let Some(reject_after) = reject_after {
            reject_after.notified().await;
            return Err(RuntimeError::PromptDeliveryFailed {
                message: "the provider refused the steer".into(),
                surfaced_on_stream: false,
            });
        }
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
    reject_after: Arc<std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>>,
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
    let reject_after = Arc::new(std::sync::Mutex::new(None));
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
                reject_after: reject_after.clone(),
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
        reject_after,
    }
}

impl Fixture {
    async fn install_acp(
        &self,
        client: &crate::domain::agents::acp::AcpClient,
        steering: bool,
    ) -> (RuntimeSessionHandle, RuntimeMessageRx) {
        let mut session =
            crate::domain::agents::acp::runtime::test_support::assembled_prompt_session(
                client, steering,
            );
        let events = session.take_message_rx();
        let runtime = Arc::new(RwLock::new(session));
        let mut handles = self.sessions.lock().await;
        let handle = handles.get_mut(&self.db_id).unwrap();
        let QueryState::Active { query, .. } = &mut handle.state else {
            panic!("fixture must own a live runtime");
        };
        *query = runtime.clone();
        (runtime, events)
    }

    /// Send a follow-up while the test holds the turn barrier, and wait until
    /// it is accepted (persisted) and waits at that barrier.
    async fn send_held_follow_up(&self) -> tokio::task::JoinHandle<()> {
        self.send_follow_up(true).await
    }

    /// `track`: whether the client asks for the agent's receipt.
    async fn send_follow_up(&self, track: bool) -> tokio::task::JoinHandle<()> {
        let dispatch = self.dispatch_prompt(FOLLOW_UP, "and the docs too", track);
        self.wait_persisted(FOLLOW_UP).await;
        dispatch
    }

    /// Send a tracked prompt, without waiting for anything.
    fn dispatch_prompt(&self, uuid: &str, text: &str, track: bool) -> tokio::task::JoinHandle<()> {
        let envelope = make_envelope(
            "session",
            "prompt.send",
            serde_json::json!({
                "session_id": self.session_id,
                "text": text,
                "message_uuid": uuid,
                "track_prompt_receipt": track,
            }),
        );
        let (tx, sessions, app_state) = (
            self.tx.clone(),
            self.sessions.clone(),
            self.app_state.clone(),
        );
        tokio::spawn(async move {
            dispatch_envelope(envelope, &tx, &sessions, &app_state).await;
        })
    }

    async fn wait_persisted(&self, uuid: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while self.delivery_state_of(uuid).await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the prompt is persisted");
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
        self.delivery_state_of(FOLLOW_UP).await
    }

    async fn wait_failed_of(&self, uuid: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while self.delivery_state_of(uuid).await.as_deref() != Some("delivery_failed") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the withdrawn prompt reads as not delivered");
    }

    async fn delivery_state_of(&self, uuid: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT delivery_state FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
        )
        .bind(self.db_id)
        .bind(uuid)
        .fetch_optional(&self.app_state.write_pool)
        .await
        .unwrap()
        .map(|state| state.unwrap_or_else(|| "none".to_string()))
    }
}

#[tokio::test]
async fn a_scoped_refusal_keeps_the_runtime_status_and_records_failed_delivery() {
    let mut fixture = fixture(true).await;
    let release = Arc::new(tokio::sync::Notify::new());
    *fixture.reject_after.lock().unwrap() = Some(release.clone());
    let dispatch = fixture.send_follow_up(true).await;
    tokio::time::timeout(std::time::Duration::from_secs(3), fixture.streamed.recv())
        .await
        .unwrap()
        .unwrap();
    // The retained boundary reached the reader first and marked all
    // still-pending delivery unknown. The definitive RPC error wins.
    crate::domain::sessions::user_messages::resolve_pending_delivery_states(
        &fixture.app_state.write_pool,
        fixture.db_id,
        "delivery_unknown",
    )
    .await
    .unwrap();
    release.notify_one();
    dispatch.await.unwrap();
    wait_for_failed(&fixture).await;
    assert_eq!(fixture.dispatch_status().await, "error");
    assert_eq!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );
    assert!(fixture.app_state.session_status_tx.is_busy(fixture.db_id));
}

#[tokio::test]
async fn a_wait_for_delivery_refusal_fails_the_dispatch_without_pausing_the_runtime() {
    let mut fixture = fixture(true).await;
    let release = Arc::new(tokio::sync::Notify::new());
    *fixture.reject_after.lock().unwrap() = Some(release.clone());
    let state = fixture.app_state.clone();
    let id = fixture.db_id;
    let dispatch = tokio::spawn(async move {
        crate::domain::ws_session::runtime::application::dispatch_control_prompt_with_message_uuid(
            &state,
            1,
            id,
            "and the docs too",
            false,
            Some(FOLLOW_UP.parse().unwrap()),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), fixture.streamed.recv())
        .await
        .unwrap()
        .unwrap();
    release.notify_one();
    let error = dispatch
        .await
        .unwrap()
        .expect_err("refusal reaches the waiting caller");
    assert!(error.to_string().contains("the provider refused the steer"));
    assert_eq!(fixture.dispatch_status().await, "error");
    assert_eq!(
        db_status(&fixture.app_state, fixture.db_id).await,
        "running"
    );
}

#[tokio::test]
async fn cooperative_stop_of_an_acp_control_prompt_preserves_the_dispatched_row() {
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::ws_session::runtime::application::dispatch_control_prompt_with_message_uuid;

    for steering in [false, true] {
        let fixture = fixture(false).await;
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let (_runtime, _events) = fixture.install_acp(&client, steering).await;

        let state = fixture.app_state.clone();
        let id = fixture.db_id;
        let delivery = tokio::spawn(async move {
            dispatch_control_prompt_with_message_uuid(
                &state,
                1,
                id,
                "start then stop",
                false,
                Some(FOLLOW_UP.parse().unwrap()),
            )
            .await
        });
        let request =
            tokio::time::timeout(std::time::Duration::from_secs(3), read_request(&mut stdin))
                .await
                .expect("control prompt must reach ACP");
        assert_eq!(request["method"], "session/prompt");
        stop_session(&fixture.app_state, Some(&fixture.sessions), fixture.db_id)
            .await
            .unwrap();
        assert_eq!(read_request(&mut stdin).await["method"], "session/cancel");
        send_response(
            &mut stdout,
            request["id"].clone(),
            serde_json::json!({"stopReason":"cancelled"}),
        )
        .await;
        tokio::time::timeout(std::time::Duration::from_secs(3), delivery)
            .await
            .unwrap()
            .unwrap()
            .expect("delivery succeeded before the cooperative Stop");
        assert_eq!(fixture.dispatch_status().await, "dispatched");
        assert_ne!(
            fixture.delivery_state().await.as_deref(),
            Some("delivery_failed")
        );
    }
}

#[tokio::test]
async fn disconnecting_a_control_waiter_does_not_abandon_the_native_steer() {
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::ws_session::runtime::application::dispatch_control_prompt_with_message_uuid;
    use std::time::Duration;

    let fixture = fixture(true).await;
    let (client, mut stdout, mut stdin) = build_in_memory_client().await;
    let (runtime, mut events) = fixture.install_acp(&client, true).await;
    let original = tokio::spawn(async move {
        runtime
            .read()
            .await
            .stream_input(serde_json::json!("original"))
            .await
    });
    let old = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stdin))
        .await
        .unwrap();
    let app_state = fixture.app_state.clone();
    let session_id = fixture.db_id;
    let waiter = tokio::spawn(async move {
        dispatch_control_prompt_with_message_uuid(
            &app_state,
            1,
            session_id,
            "steer then disconnect",
            false,
            Some(FOLLOW_UP.parse().unwrap()),
        )
        .await
    });
    let steer = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stdin))
        .await
        .unwrap();
    assert_eq!(steer["method"], "session/prompt");
    send_response(
        &mut stdout,
        old["id"].clone(),
        serde_json::json!({"stopReason":"end_turn"}),
    )
    .await;
    original.await.unwrap().unwrap();
    assert!(
        events.try_recv().is_err(),
        "P1 must leave the overlapping turn open"
    );
    assert_eq!(fixture.dispatch_status().await, "dispatching");

    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    send_response(
        &mut stdout,
        steer["id"].clone(),
        serde_json::json!({"stopReason":"end_turn"}),
    )
    .await;
    let final_result = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .expect("a disconnected caller cannot strand the accepted ACP turn")
        .unwrap()
        .unwrap();
    assert!(final_result.is_result());
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.dispatch_status().await != "dispatched" {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the native steer must settle its durable dispatch");
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
        .record_stop(fixture.db_id, None);
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

/// A Stop that came before a prompt sent while idle stopped something else:
/// the prompt starts its turn.
#[tokio::test]
async fn a_stop_before_an_idle_prompt_does_not_cancel_it() {
    let mut fixture = fixture(false).await;
    fixture
        .app_state
        .active_turns
        .followups()
        .record_stop(fixture.db_id, None);

    fixture.send_held_follow_up().await.await.unwrap();

    tokio::time::timeout(std::time::Duration::from_secs(2), fixture.streamed.recv())
        .await
        .expect("the prompt still reaches the runtime");
    assert_ne!(
        fixture.delivery_state().await.as_deref(),
        Some("delivery_failed")
    );
}

async fn wait_for_failed(fixture: &Fixture) {
    fixture.wait_failed_of(FOLLOW_UP).await;
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
        .record_stop(fixture.db_id, None);
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

/// Regression for session 4442: a queued user prompt dispatched to an ACP
/// runtime must return once `session/prompt` hits the wire (not wait for the
/// entire turn), so post-turn queue draining and `StreamReaderTask` never
/// deadlock while the new turn streams events.
#[tokio::test]
async fn queued_user_prompt_returns_on_acp_wire_submission_before_turn_ends() {
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::ws_session::runtime::application::dispatch_queued_user_prompt;
    use std::time::Duration;

    let fixture = fixture(false).await;
    let (client, mut stdout, mut stdin) = build_in_memory_client().await;
    let (_runtime, mut events) = fixture.install_acp(&client, true).await;

    let state = fixture.app_state.clone();
    let id = fixture.db_id;
    let dispatch = tokio::spawn(async move {
        dispatch_queued_user_prompt(&state, 1, id, "/finish-job", FOLLOW_UP.parse().unwrap()).await
    });

    let request = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stdin))
        .await
        .expect("queued prompt must reach ACP stdin");
    assert_eq!(request["method"], "session/prompt");

    // Must return immediately after wire submission — BEFORE the ACP agent
    // replies to `session/prompt`!
    tokio::time::timeout(Duration::from_secs(2), dispatch)
        .await
        .expect("queued user prompt must not block waiting for the full ACP turn")
        .unwrap()
        .expect("queued user prompt submission should succeed");

    // Now the agent finishes the turn; settlement still runs in the background
    // and publishes the Result event + marks dispatch succeeded.
    send_response(
        &mut stdout,
        request["id"].clone(),
        serde_json::json!({ "stopReason": "end_turn" }),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(item) = events.recv().await {
            if item.expect("event").is_result() {
                return;
            }
        }
        panic!("ACP stream closed without Result");
    })
    .await
    .expect("background settlement must emit Result");
    assert_eq!(fixture.dispatch_status().await, "dispatched");
}

/// When a queued user prompt fails on ACP *after* wire submission (the caller
/// already returned `Ok(())`), its error must still be broadcast as a visible
/// `session.error` frame rather than being lost in a dropped headless collector.
#[tokio::test]
async fn queued_user_prompt_post_submission_failure_broadcasts_visible_error() {
    use crate::domain::agents::acp::runtime::test_support::{build_in_memory_client, read_request};
    use crate::domain::ws_session::runtime::application::dispatch_queued_user_prompt;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    let fixture = fixture(false).await;
    let (client, mut stdout, mut stdin) = build_in_memory_client().await;
    let (_runtime, mut events) = fixture.install_acp(&client, false).await;

    let state = fixture.app_state.clone();
    let id = fixture.db_id;
    let dispatch = tokio::spawn(async move {
        dispatch_queued_user_prompt(
            &state,
            1,
            id,
            "fail after submit",
            FOLLOW_UP.parse().unwrap(),
        )
        .await
    });

    let request = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stdin))
        .await
        .expect("queued prompt must reach ACP stdin");
    tokio::time::timeout(Duration::from_secs(2), dispatch)
        .await
        .expect("returns immediately on wire submission")
        .unwrap()
        .unwrap();

    // Agent rejects the prompt AFTER submission returned Ok(()).
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request["id"],
        "error": { "code": -32000, "message": "agent rejected prompt" }
    });
    stdout
        .write_all(format!("{frame}\n").as_bytes())
        .await
        .unwrap();

    // PromptDeliveryFailed surfaces as Result with error on the ACP stream and
    // marks the dispatch row failed in DB.
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(item) = events.recv().await {
            if let Ok(event) = item {
                if event.is_result() && event.result_error().is_some() {
                    return;
                }
            }
        }
        panic!("expected surfaced result error on ACP stream");
    })
    .await
    .expect("post-submission ACP rejection must surface on stream");

    tokio::time::timeout(Duration::from_secs(2), async {
        while fixture.dispatch_status().await != "error" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("post-submission rejection must record dispatch failure");
}

mod checkpoint_window;
