use std::path::PathBuf;

use axum::extract::ws::Message;
use tracing::info;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::session_gate::clear_persisted_gate_and_notify;
use super::super::types::{QueryState, SdkSessions, WsSender};
use super::interrupt::{interrupt_as_intended, StopReason};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::protocol::GateCloseReason;
use crate::domain::ws_session::runtime::helpers::report_if_unsaved;
use crate::domain::ws_session::runtime::output::{CommandError, OutputTarget};

/// Broadcast a `session.lifecycle` envelope so the frontend turn-lifecycle
/// state machine flips only on backend-confirmed transitions (per
/// `no-optimistic-updates.md`). Used by both suspend and resume paths.
fn broadcast_lifecycle(sender: &impl OutputTarget, session_id: i64, kind: SessionLifecycleKind) {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Lifecycle(SessionLifecyclePayload {
        session_id: session_id.to_string(),
        kind,
    }))
    .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(envelope).into()));
}

/// Handle `session.suspend`. Provider-neutral pause driven by the renderer
/// when the OS reports a pending suspend. For an active runtime we capture the
/// session id (so it can be `--resume`'d after wake even if the subprocess
/// dies), stop the in-flight turn through the runtime's bounded
/// `interrupt_before_sleep`, and persist `paused` to the DB. Once nothing runs,
/// persisted permission/question gates are closed: nobody answers them while
/// the machine sleeps. A pause the agent refuses leaves its gate open.
pub(crate) async fn handle_suspend(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    // One correlated answer: the outcome. The gate it closes and the pause it
    // announces go out as events, so a refused pause is not settled early by
    // an earlier reply (the desktop tracks `session.suspend` as a command).
    match suspend_session(app_state, sdk_sessions, db_session_id, sender).await {
        Ok(()) => acknowledge_suspend(sender, &envelope.id),
        Err(error) => send_error(sender, &envelope.id, error.code, &error.message),
    }
}

fn acknowledge_suspend(sender: &WsSender, envelope_id: &str) {
    let reply = WsEnvelope::session_reply(
        envelope_id,
        &WsSessionEvent::Acknowledged(SessionAcknowledgedPayload {
            action: "suspend".into(),
        }),
    )
    .expect("suspend acknowledgement should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
}

/// The work behind `session.suspend`, for the socket that holds the
/// conversation (`sdk_sessions` is its map) and for the HTTP suspend used for
/// conversations no client has open (the service registry's cell). `output`
/// receives the gate and lifecycle events; headless, every other client
/// still learns the outcome from the status book.
pub(crate) async fn suspend_session(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    output: &impl OutputTarget,
) -> Result<(), CommandError> {
    // Extract the live query handle while briefly holding the lock, then
    // drop it so the stop's await doesn't block other handlers (same pattern
    // as `handle_permission_respond`).
    let active: Option<(RuntimeSessionHandle, String, i64)> = {
        let sessions = sdk_sessions.lock().await;
        sessions
            .get(&db_session_id)
            .and_then(|handle| match &handle.state {
                QueryState::Active { query, .. } => Some((
                    std::sync::Arc::clone(query),
                    handle.runtime_provider.clone(),
                    handle.feature_id,
                )),
                QueryState::Pending(_) => None,
            })
    };

    let Some((query, runtime_provider, feature_id)) = active else {
        // No live runtime: nothing to interrupt, no resume id to persist, no
        // banner to flip; a gate left from an earlier runtime still closes.
        return close_gates_for_sleep(output, app_state, db_session_id)
            .await
            .map_err(|error| {
                CommandError::new(
                    "DB_ERROR",
                    format!("Failed to close pending gate before sleep: {error}"),
                )
            });
    };

    // Refused mid-turn, this returns before the gate closes: the agent works
    // on, and its gate stays answerable on every device.
    let (cli_sid, allows_resume_persistence) =
        pause_running_turn(app_state, &query, db_session_id).await?;
    let gates_closed = close_gates_for_sleep(output, app_state, db_session_id).await;
    let resume_id = super::super::session_init_resume::persistable_resume_session_id_for_provider(
        &runtime_provider,
        cli_sid.as_deref(),
        allows_resume_persistence,
    );
    record_pause(
        app_state,
        db_session_id,
        feature_id,
        &runtime_provider,
        resume_id.as_deref(),
    )
    .await;
    // The agent paused, so the command succeeded; a gate left unclosed is
    // reported like the pause's other writes.
    report_if_unsaved(
        &app_state.ws_feature_senders,
        feature_id,
        db_session_id,
        "that its pending request closed",
        gates_closed,
    )
    .await;
    broadcast_lifecycle(
        output,
        db_session_id,
        SessionLifecycleKind::SuspendRequested,
    );
    Ok(())
}

/// Close the persisted gates nobody will answer during the sleep.
async fn close_gates_for_sleep(
    output: &impl OutputTarget,
    app_state: &AppState,
    db_session_id: i64,
) -> Result<(), sqlx::Error> {
    clear_persisted_gate_and_notify(
        output,
        app_state,
        db_session_id,
        None,
        GateCloseReason::Sleep,
        None,
    )
    .await
    .map(|_| ())
}

/// Persist the paused session — its resume point first, so a resume survives
/// a subprocess death during the sleep (the DB is the source of truth for
/// resume ids across restarts) — and report it idle.
async fn record_pause(
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    runtime_provider: &str,
    resume_id: Option<&str>,
) {
    let senders = &app_state.ws_feature_senders;
    if let Some(sid) = resume_id {
        let written = WsSessionPersistence::persist_runtime_session_id_static(
            &app_state.write_pool,
            db_session_id,
            runtime_provider,
            sid,
        )
        .await;
        report_if_unsaved(
            senders,
            feature_id,
            db_session_id,
            "its resume point",
            written,
        )
        .await;
    }
    let paused =
        WsSessionPersistence::mark_paused_static(&app_state.write_pool, db_session_id).await;
    report_if_unsaved(
        senders,
        feature_id,
        db_session_id,
        "that the agent paused",
        paused,
    )
    .await;
    app_state.session_status_tx.broadcast(
        db_session_id,
        feature_id,
        crate::domain::session_status::AgentStatus::Idle,
        None,
    );
}

/// Stop the running turn before sleep and return the runtime's resume id
/// (read first: once the subprocess tears down, some adapters lose it) and
/// whether it may be persisted.
///
/// A running turn is stopped as a Stop stops it, marked as intended (see
/// `interrupt_as_intended`). Whether one runs is read under the barrier, last:
/// a mark left on a turn that already ended would make the next turn's end
/// read as that old stop. A turn waiting on its gate runs (the gate is still
/// open here).
async fn pause_running_turn(
    app_state: &AppState,
    query: &RuntimeSessionHandle,
    db_session_id: i64,
) -> Result<(Option<String>, bool), CommandError> {
    let q = query.read().await;
    let sid = q.session_id().await;
    let allows_resume_persistence = q.allows_resume_persistence();
    let _barrier = q.turn_control_guard().await;
    let turn_running = app_state.session_status_tx.is_busy(db_session_id);
    let result = interrupt_as_intended(
        app_state,
        query,
        &**q,
        db_session_id,
        turn_running,
        StopReason::Sleep,
    )
    .await;
    drop(q);
    if let Err(error) = result {
        // Mid-turn, the agent refused the pause and works on into the sleep:
        // the caller must hear it, and the session is not marked paused.
        // Between turns there was nothing to pause (a runtime whose process
        // already ended refuses any control), so the pause goes on.
        if turn_running {
            return Err(CommandError::new(
                "SDK_ERROR",
                format!("The agent did not pause for sleep: {error}"),
            ));
        }
        info!(db_session_id, %error, "suspend: no turn was running to interrupt");
    }
    Ok((sid, allows_resume_persistence))
}

/// Handle `session.resume`. Counterpart to `handle_suspend`: provider-neutral
/// acknowledgement of OS wake. We don't respawn anything — the renderer has
/// already called `forceReconnectAll` to refresh transport, and the next
/// user prompt picks up `resume_session_id` from the DB via the existing
/// pending-spawn path. The lifecycle envelope is broadcast unconditionally
/// because the renderer can fan this out before the reconnect has finished
/// rebuilding `sdk_sessions` — an existence check here would race the new
/// connection and produce spurious `SESSION_NOT_FOUND` errors.
pub(crate) async fn handle_resume(envelope: WsEnvelope, sender: &WsSender) {
    let payload: SessionActionPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    broadcast_lifecycle(sender, db_session_id, SessionLifecycleKind::Resumed);
}

/// Handle session.retry_worktree_setup: re-run setup commands for an existing worktree.
pub(crate) async fn handle_retry_worktree_setup(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    // Only feature_id is consumed here. Older clients may attach arbitrary
    // session context; retain the established ignored-field/error behavior.
    let feature_id = match envelope
        .payload
        .get("feature_id")
        .and_then(|value| value.as_i64())
    {
        Some(feature_id) => feature_id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "MISSING_FEATURE_ID",
                "feature_id is required",
            );
            return;
        }
    };

    let wt_path_str =
        match worktree::get_setting(&app_state.read_pool, feature_id, "worktree_path").await {
            Some(p) => p,
            None => {
                send_error(
                    sender,
                    &envelope.id,
                    "NO_WORKTREE",
                    "No worktree found for this feature",
                );
                return;
            }
        };

    let reply = WsEnvelope::session_reply(
        &envelope.id,
        &WsSessionEvent::RetryWorktreeSetupOk(RetryWorktreeSetupOkPayload { feature_id }),
    )
    .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(reply).into()));
    if app_state.worktree_setup_runs.is_owned(feature_id) {
        return;
    }

    let rp = app_state.read_pool.clone();
    let wp = app_state.write_pool.clone();
    let setup_runs = app_state.worktree_setup_runs.clone();
    let ws = app_state
        .ws_feature_senders
        .fan_out_sender(feature_id, sender.clone());
    let path = PathBuf::from(wt_path_str);
    tokio::spawn(async move {
        worktree::run_setup_commands(rp, wp, setup_runs, feature_id, path, ws).await;
    });
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::Value;
    use tokio::sync::{mpsc, RwLock};

    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeMessageRx, RuntimePermissionMode,
        RuntimeSessionHandle,
    };
    use crate::domain::ws_session::handler::session_prompt::permission_response_channel;
    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    /// A runtime whose normal Stop never returns (it waits out an agent that
    /// ignores it) but whose stop before sleep is bounded.
    struct SlowStopRuntime {
        paused_for_sleep: Arc<AtomicBool>,
    }

    #[async_trait]
    impl AgentRuntimeSession for SlowStopRuntime {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            mpsc::channel::<Result<RuntimeEvent, RuntimeError>>(1).1
        }
        async fn session_id(&self) -> Option<String> {
            None
        }
        async fn stream_input(&self, _content: Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            std::future::pending().await
        }
        async fn interrupt_before_sleep(&self) -> Result<(), RuntimeError> {
            self.paused_for_sleep.store(true, Ordering::SeqCst);
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

    fn lifecycle_kinds(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
        let mut kinds = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            let envelope: Value = serde_json::from_str(&text).unwrap();
            if envelope["action"] == "lifecycle" {
                kinds.push(envelope["payload"]["kind"].as_str().unwrap().to_string());
            }
        }
        kinds
    }

    /// A session whose runtime is a [`SlowStopRuntime`], with a logical turn.
    async fn slow_stop_session(
        session_id: i64,
    ) -> (SdkSessions, RuntimeSessionHandle, Arc<AtomicBool>) {
        let sessions = new_sdk_sessions();
        let paused_for_sleep = Arc::new(AtomicBool::new(false));
        let mut handle = make_active_handle(1, None);
        let (permission_tx, _permission_rx) = permission_response_channel();
        let query: RuntimeSessionHandle = Arc::new(RwLock::new(Box::new(SlowStopRuntime {
            paused_for_sleep: Arc::clone(&paused_for_sleep),
        })));
        handle.state = QueryState::Active {
            query: Arc::clone(&query),
            permission_tx,
        };
        sessions.lock().await.insert(session_id, handle);
        (sessions, query, paused_for_sleep)
    }

    async fn marked(app_state: &AppState, session_id: i64, query: &RuntimeSessionHandle) -> bool {
        app_state
            .active_turns
            .take_interruption(session_id, &Arc::downgrade(query))
            .await
            .is_some()
    }

    #[tokio::test]
    async fn a_suspend_uses_the_bounded_stop_before_sleep() {
        let app_state = make_test_app_state().await;
        let (sessions, query, paused_for_sleep) = slow_stop_session(51).await;
        app_state.active_turns.begin_turn(51, &sessions).await;
        app_state.session_status_tx.broadcast_running(51, 1);
        let (tx, mut rx) = mpsc::unbounded_channel();

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            suspend_session(&app_state, &sessions, 51, &tx),
        )
        .await
        .expect("a suspend must not wait out the normal Stop")
        .unwrap();

        assert!(paused_for_sleep.load(Ordering::SeqCst));
        assert_eq!(lifecycle_kinds(&mut rx), ["suspend_requested"]);
        // Found live: the stopped turn surfaced as the provider's
        // `ERROR_DURING_EXECUTION`. Like a Stop, the pause is marked as
        // intended, for the stream reader to end the turn as stopped.
        assert!(marked(&app_state, 51, &query).await);
    }

    /// Between turns (the turn ended, perhaps just before the pause) there is
    /// no turn to mark: the next turn's end would read as this stop.
    #[tokio::test]
    async fn a_pause_between_turns_marks_no_interruption() {
        let app_state = make_test_app_state().await;
        let (sessions, query, paused_for_sleep) = slow_stop_session(54).await;
        app_state.active_turns.begin_turn(54, &sessions).await;
        let (tx, _rx) = mpsc::unbounded_channel();

        suspend_session(&app_state, &sessions, 54, &tx)
            .await
            .unwrap();

        assert!(paused_for_sleep.load(Ordering::SeqCst));
        assert!(!marked(&app_state, 54, &query).await);
    }

    /// A session waiting on its permission gate: a persisted gate and the
    /// status book's question.
    async fn waiting_on_gate(app_state: &AppState, session_id: i64) {
        insert_running_session(app_state, session_id, 1).await;
        sqlx::query("UPDATE agent_sessions SET pending_permission = '{}' WHERE id = ?")
            .bind(session_id)
            .execute(&app_state.write_pool)
            .await
            .unwrap();
        app_state.session_status_tx.broadcast_gate(
            session_id,
            1,
            crate::domain::session_status::PendingKind::Permission,
            "perm-1".into(),
        );
    }

    async fn gate_persisted(app_state: &AppState, session_id: i64) -> bool {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT pending_permission FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(&app_state.write_pool)
        .await
        .unwrap()
        .is_some()
    }

    fn sent_actions(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<String> {
        let mut actions = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            let envelope: Value = serde_json::from_str(&text).unwrap();
            actions.push(envelope["action"].as_str().unwrap().to_string());
        }
        actions
    }

    /// A turn waiting on its gate runs: it is stopped as intended, then the
    /// gate nobody answers during the sleep closes.
    #[tokio::test]
    async fn a_pause_stops_a_turn_waiting_on_its_gate_then_closes_the_gate() {
        let app_state = make_test_app_state().await;
        waiting_on_gate(&app_state, 55).await;
        let (sessions, query, paused_for_sleep) = slow_stop_session(55).await;
        app_state.active_turns.begin_turn(55, &sessions).await;
        let (tx, mut rx) = mpsc::unbounded_channel();

        suspend_session(&app_state, &sessions, 55, &tx)
            .await
            .unwrap();

        assert!(paused_for_sleep.load(Ordering::SeqCst));
        assert!(marked(&app_state, 55, &query).await);
        assert!(!gate_persisted(&app_state, 55).await);
        assert_eq!(sent_actions(&mut rx), ["gate.closed", "lifecycle"]);
        assert!(!app_state.session_status_tx.is_busy(55));
    }

    /// Found in review: the suspend closed the gate before stopping the turn,
    /// so a refused pause left an agent blocked on a gate nobody could answer
    /// any more. The gate stays open, persisted and in the status book, for
    /// this device and every other one to answer.
    #[tokio::test]
    async fn a_refused_pause_leaves_the_gate_open() {
        let app_state = make_test_app_state().await;
        waiting_on_gate(&app_state, 58).await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(58, make_active_handle(1, Some("cli".into())));
        let (tx, mut rx) = mpsc::unbounded_channel();

        let error = suspend_session(&app_state, &sessions, 58, &tx)
            .await
            .unwrap_err();

        assert_eq!(error.code, "SDK_ERROR");
        assert!(gate_persisted(&app_state, 58).await);
        assert!(sent_actions(&mut rx).is_empty(), "no gate.closed, no pause");
        assert!(app_state.session_status_tx.is_busy(58));
        assert_eq!(
            app_state.session_status_tx.snapshot().states["58"].status,
            crate::domain::session_status::AgentStatus::Question
        );
    }

    /// Without a live runtime nothing runs: a gate left over still closes.
    #[tokio::test]
    async fn a_pause_without_a_runtime_closes_a_leftover_gate() {
        let app_state = make_test_app_state().await;
        waiting_on_gate(&app_state, 59).await;
        let sessions = new_sdk_sessions();
        let (tx, mut rx) = mpsc::unbounded_channel();

        suspend_session(&app_state, &sessions, 59, &tx)
            .await
            .unwrap();

        assert!(!gate_persisted(&app_state, 59).await);
        assert_eq!(sent_actions(&mut rx), ["gate.closed"]);
    }

    /// The stub runtime refuses every control (`stdin is closed`). Mid-turn,
    /// that is an agent working on into the sleep: the caller is told, and
    /// the session is not reported paused.
    #[tokio::test]
    async fn a_pause_refused_mid_turn_is_reported_not_announced() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(52, make_active_handle(1, Some("cli".into())));
        app_state.session_status_tx.broadcast_running(52, 1);
        let (tx, mut rx) = mpsc::unbounded_channel();

        let error = suspend_session(&app_state, &sessions, 52, &tx)
            .await
            .unwrap_err();

        assert_eq!(error.code, "SDK_ERROR");
        assert!(
            error.message.contains("stdin is closed"),
            "{}",
            error.message
        );
        assert!(lifecycle_kinds(&mut rx).is_empty());
        assert!(app_state.session_status_tx.is_busy(52));
    }

    /// Between turns nothing runs to pause: a refused control is no failure
    /// and the pause still completes.
    /// The actions of the replies correlated to `ref_id`, in order.
    fn replies_to(rx: &mut mpsc::UnboundedReceiver<Message>, ref_id: &str) -> Vec<String> {
        let mut actions = Vec::new();
        while let Ok(Message::Text(text)) = rx.try_recv() {
            let envelope: Value = serde_json::from_str(&text).unwrap();
            if envelope["ref"] == ref_id {
                actions.push(envelope["action"].as_str().unwrap().to_string());
            }
        }
        actions
    }

    async fn socket_suspend(
        app_state: &AppState,
        sessions: &SdkSessions,
        session_id: i64,
    ) -> Vec<String> {
        let envelope = crate::domain::ws_session::handler::tests::support::make_envelope(
            "session",
            "suspend",
            serde_json::json!({ "session_id": session_id.to_string() }),
        );
        let ref_id = envelope.id.clone();
        let (tx, mut rx) = mpsc::unbounded_channel();
        handle_suspend(envelope, &tx, sessions, app_state).await;
        replies_to(&mut rx, &ref_id)
    }

    /// Found in review: the gate the pause closed answered the command first,
    /// so the desktop took a later refusal for a failed turn. The socket
    /// suspend answers once, with its outcome.
    #[tokio::test]
    async fn a_socket_suspend_answers_once_with_its_outcome() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 56, 1).await;
        sqlx::query("UPDATE agent_sessions SET pending_permission = '{}' WHERE id = 56")
            .execute(&app_state.write_pool)
            .await
            .unwrap();
        let refused = new_sdk_sessions();
        refused
            .lock()
            .await
            .insert(56, make_active_handle(1, Some("cli".into())));
        app_state.session_status_tx.broadcast_gate(
            56,
            1,
            crate::domain::session_status::PendingKind::Permission,
            "perm-1".into(),
        );

        assert_eq!(socket_suspend(&app_state, &refused, 56).await, ["error"]);

        insert_running_session(&app_state, 57, 1).await;
        let (paused, _, _) = slow_stop_session(57).await;
        app_state.session_status_tx.broadcast_running(57, 1);

        assert_eq!(
            socket_suspend(&app_state, &paused, 57).await,
            ["acknowledged"]
        );
    }

    #[tokio::test]
    async fn a_pause_between_turns_completes_without_a_running_turn() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        sessions
            .lock()
            .await
            .insert(53, make_active_handle(1, Some("cli".into())));
        let (tx, mut rx) = mpsc::unbounded_channel();

        suspend_session(&app_state, &sessions, 53, &tx)
            .await
            .unwrap();

        assert_eq!(lifecycle_kinds(&mut rx), ["suspend_requested"]);
    }
}
