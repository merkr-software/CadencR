//! Provider-neutral Stop escalation watchdog and ghost-busy reconciliation.
//!
//! When a provider accepts Stop (`interrupt() -> Ok(())`) but its working turn
//! never settles (neither to `Idle` nor to a pending user-input gate), this
//! watchdog forcefully terminates the unresponsive runtime after
//! [`STOP_ESCALATION_GRACE`] and settles the session cleanly.

use std::time::Duration;

use axum::extract::ws::Message;
use tokio::sync::broadcast;

use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeSessionWeakHandle, STOP_ESCALATION_GRACE};
use crate::domain::session_status::{AgentStatus, SessionStatusEvent};
use crate::domain::ws_session::handler::types::SdkSessions;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{SessionEndedPayload, WsEnvelope, WsSessionEvent};
use crate::domain::ws_session::runtime::helpers::{
    broadcast_session_error, report_if_unsaved, AGENT_STOP_ESCALATED,
};
use crate::domain::ws_session::runtime::prompt::followup_withdrawal::{
    end_turn_idle, fail_stopped_followups,
};
use crate::domain::ws_session::runtime::prompt::stream_reader_resume::retire_active_runtime_to_pending;

/// Grace after `terminate_unresponsive_stop` for `StreamReaderTask` to publish
/// the normal interrupted end before the watchdog force-settles directly.
const POST_TERMINATION_SETTLE_GRACE: Duration = Duration::from_secs(3);
/// Bound on acquiring `query.read()` inside the watchdog so a stuck write lock
/// cannot prevent fallback idle settlement.
const RUNTIME_READ_TIMEOUT: Duration = Duration::from_secs(2);
/// Grace after `RuntimeError::NothingToInterrupt` for an already-in-flight
/// `Result` to settle before clearing a ghost busy state.
pub(super) const GHOST_BUSY_RECONCILE_GRACE: Duration = Duration::from_secs(2);

pub(super) const WATCHDOG_GRACE: Duration = STOP_ESCALATION_GRACE;

#[derive(bon::Builder)]
pub(super) struct StopWatch {
    app_state: AppState,
    sessions: Option<SdkSessions>,
    query: Option<RuntimeSessionWeakHandle>,
    db_session_id: i64,
    feature_id: i64,
    generation: Option<u64>,
    status_rx: broadcast::Receiver<SessionStatusEvent>,
    grace: Duration,
}

impl StopWatch {
    pub(super) fn spawn_escalation(self) {
        let Some(guard) = self
            .app_state
            .active_turns
            .try_claim_stop_watch(self.db_session_id, self.generation)
        else {
            return;
        };
        tokio::spawn(async move {
            let _guard = guard;
            self.run_escalation().await;
        });
    }

    pub(super) fn spawn_nothing_to_interrupt_reconciler(mut self) {
        let Some(guard) = self
            .app_state
            .active_turns
            .try_claim_stop_watch(self.db_session_id, self.generation)
        else {
            return;
        };
        tokio::spawn(async move {
            let _guard = guard;
            if self.wait_for_settle(self.grace).await {
                return;
            }
            tracing::warn!(
                db_session_id = self.db_session_id,
                feature_id = self.feature_id,
                "session remained busy after NothingToInterrupt; reconciling to idle"
            );
            end_turn_idle_for(
                &self.app_state,
                self.db_session_id,
                self.feature_id,
                self.generation,
            )
            .await;
        });
    }

    async fn run_escalation(mut self) {
        if self.wait_for_settle(self.grace).await {
            return;
        }
        let reason = format!(
            "The agent did not stop within {}s after Stop; its process was terminated.",
            self.grace.as_secs().max(1)
        );
        tracing::warn!(
            db_session_id = self.db_session_id,
            feature_id = self.feature_id,
            "{reason}"
        );
        if let Some(handle) = self.query.as_ref().and_then(std::sync::Weak::upgrade) {
            match tokio::time::timeout(RUNTIME_READ_TIMEOUT, handle.read()).await {
                Ok(runtime) => {
                    let terminated = runtime.terminate_unresponsive_stop(reason.clone()).await;
                    drop(runtime);
                    if terminated && self.wait_for_settle(POST_TERMINATION_SETTLE_GRACE).await {
                        return;
                    }
                }
                Err(_) => {
                    tracing::warn!(
                        db_session_id = self.db_session_id,
                        "timed out acquiring runtime read lock during stop escalation"
                    );
                }
            }
        }
        self.force_settle(&reason).await;
    }

    /// A working turn is settled once the session is no longer in
    /// `AgentStatus::Agent` (idle OR parked on a pending user-input gate) OR
    /// the generation has ended / been replaced by a newer turn.
    async fn is_settled(&self) -> bool {
        if self
            .app_state
            .session_status_tx
            .busy_non_gate_feature_id(self.db_session_id)
            .is_none()
        {
            return true;
        }
        match self.generation {
            Some(generation) => {
                !self
                    .app_state
                    .active_turns
                    .is_running_generation(self.db_session_id, generation)
                    .await
            }
            None => self
                .app_state
                .active_turns
                .current_generation(self.db_session_id)
                .await
                .is_some(),
        }
    }

    async fn wait_for_settle(&mut self, timeout: Duration) -> bool {
        if self.is_settled().await {
            return true;
        }
        let settled = tokio::time::timeout(timeout, async {
            loop {
                match self.status_rx.recv().await {
                    Ok(event) if event.session_id == self.db_session_id => {
                        if event.status != AgentStatus::Agent || self.is_settled().await {
                            return true;
                        }
                    }
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if self.is_settled().await {
                            return true;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return self.is_settled().await,
                }
            }
        })
        .await;
        match settled {
            Ok(true) => true,
            _ => self.is_settled().await,
        }
    }

    /// Last-resort fallback when the runtime could not be terminated or its
    /// stream reader never settled: retire the dead `Active` handle to `Pending`
    /// (neutralizing any late stream reader and letting the next prompt spawn
    /// fresh), resolve pending follow-ups/receipts, persist the interruption and
    /// escalation markers, and broadcast `Idle`, `session.ended`, and
    /// `session.error(AGENT_STOP_ESCALATED)`.
    async fn force_settle(&self, reason: &str) {
        let _generation_lock = self
            .app_state
            .active_turns
            .lock_turn_generation(self.db_session_id)
            .await;
        if self.is_settled().await {
            return;
        }
        if let Some(target) = self.query.as_ref() {
            let sessions = match self.sessions.as_ref() {
                Some(sessions) => Some(sessions.clone()),
                None => {
                    self.app_state
                        .session_runtimes
                        .get(self.db_session_id)
                        .await
                }
            };
            if let Some(sessions) = sessions {
                retire_active_runtime_to_pending(&sessions, self.db_session_id, target).await;
            }
        }
        let unwithdrawn = self
            .app_state
            .active_turns
            .followups()
            .turn_ended(self.db_session_id);
        if !unwithdrawn.is_empty() {
            fail_stopped_followups(
                &self.app_state.write_pool,
                &self.app_state.ws_feature_senders,
                self.feature_id,
                self.db_session_id,
                unwithdrawn,
            )
            .await;
        }
        if let Err(error) = crate::domain::sessions::user_messages::resolve_pending_delivery_states(
            &self.app_state.write_pool,
            self.db_session_id,
            "delivery_failed",
        )
        .await
        {
            tracing::error!(
                self.db_session_id,
                %error,
                "failed to resolve pending prompt receipts during forced stop settlement"
            );
        }
        self.app_state
            .active_turns
            .end_turn(self.db_session_id)
            .await;
        WsSessionPersistence::persist_turn_interrupted_static(
            &self.app_state.write_pool,
            self.db_session_id,
        )
        .await;
        WsSessionPersistence::persist_error_message_static(
            &self.app_state.write_pool,
            self.db_session_id,
            reason,
            None,
        )
        .await;
        let completed = WsSessionPersistence::mark_completed_static(
            &self.app_state.write_pool,
            self.db_session_id,
        )
        .await;
        report_if_unsaved(
            &self.app_state.ws_feature_senders,
            self.feature_id,
            self.db_session_id,
            "that the agent stopped",
            completed,
        )
        .await;
        self.app_state.session_status_tx.broadcast(
            self.db_session_id,
            self.feature_id,
            AgentStatus::Idle,
            None,
        );
        let ended = WsEnvelope::session_event(&WsSessionEvent::Ended(SessionEndedPayload {
            reason: "turn_interrupted".into(),
            received_prompt_message_uuids: Vec::new(),
        }))
        .expect("session ended payload should serialize");
        let ended_frame = Message::Text(String::from(ended).into());
        self.app_state
            .ws_feature_senders
            .broadcast_all(self.feature_id, &ended_frame)
            .await;
        broadcast_session_error(
            &self.app_state.ws_feature_senders,
            self.feature_id,
            AGENT_STOP_ESCALATED,
            reason.to_string(),
        )
        .await;
    }
}

pub(super) async fn end_turn_idle_for(
    app_state: &AppState,
    db_session_id: i64,
    feature_id: i64,
    generation: Option<u64>,
) {
    end_turn_idle()
        .pool(&app_state.write_pool)
        .feature_senders(&app_state.ws_feature_senders)
        .status(&app_state.session_status_tx)
        .active_turns(&app_state.active_turns)
        .session_id(db_session_id)
        .feature_id(feature_id)
        .maybe_generation(generation)
        .call()
        .await;
}

/// Clear a ghost working status when Stop finds no live runtime cell at all and
/// no spawn or pending gate explains it, re-checking under the generation lock
/// so a concurrently started turn is never cleared.
pub(super) async fn reconcile_orphaned_busy_session(app_state: &AppState, db_session_id: i64) {
    let Some(feature_id) = app_state
        .session_status_tx
        .busy_non_gate_feature_id(db_session_id)
    else {
        return;
    };
    let generation_before = app_state
        .active_turns
        .current_generation(db_session_id)
        .await;
    let _generation_lock = app_state
        .active_turns
        .lock_turn_generation(db_session_id)
        .await;
    if app_state.session_runtimes.is_spawning(db_session_id).await
        || app_state
            .session_runtimes
            .get(db_session_id)
            .await
            .is_some()
        || app_state
            .active_turns
            .owner_sessions(db_session_id)
            .await
            .is_some()
        || app_state
            .active_turns
            .current_generation(db_session_id)
            .await
            != generation_before
        || app_state
            .session_status_tx
            .busy_non_gate_feature_id(db_session_id)
            != Some(feature_id)
    {
        return;
    }
    tracing::warn!(
        db_session_id,
        feature_id,
        "reconciling orphaned busy session without a live runtime to idle"
    );
    app_state.active_turns.end_turn(db_session_id).await;
    let completed =
        WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;
    report_if_unsaved(
        &app_state.ws_feature_senders,
        feature_id,
        db_session_id,
        "that the agent is idle",
        completed,
    )
    .await;
    app_state
        .session_status_tx
        .broadcast(db_session_id, feature_id, AgentStatus::Idle, None);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::*;
    use crate::domain::agents::adapter::{
        AgentRuntimeSession, RuntimeError, RuntimeMessageRx, RuntimePermissionMode,
        RuntimeSessionHandle, RuntimeSpawnConfig,
    };
    use crate::domain::session_status::PendingKind;
    use crate::domain::ws_session::handler::session_control::interrupt::{
        stop_session, NOTHING_TO_STOP,
    };
    use crate::domain::ws_session::handler::tests::support::{
        insert_running_session, make_active_handle, make_test_app_state,
    };
    use crate::domain::ws_session::handler::types::{new_sdk_sessions, QueryState};

    struct StuckRuntime {
        terminated: Arc<AtomicBool>,
        can_terminate: bool,
    }

    #[async_trait::async_trait]
    impl AgentRuntimeSession for StuckRuntime {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            tokio::sync::mpsc::channel(1).1
        }
        async fn session_id(&self) -> Option<String> {
            Some("stuck".into())
        }
        async fn stream_input(&self, _: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }
        async fn terminate_unresponsive_stop(&self, _reason: String) -> bool {
            self.terminated.store(true, Ordering::SeqCst);
            self.can_terminate
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
    async fn watchdog_terminates_retires_handle_and_force_settles_unresponsive_stop() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 81, 1).await;
        let sessions = new_sdk_sessions();
        let terminated = Arc::new(AtomicBool::new(false));
        let runtime: RuntimeSessionHandle =
            Arc::new(tokio::sync::RwLock::new(Box::new(StuckRuntime {
                terminated: Arc::clone(&terminated),
                can_terminate: false,
            })));
        let mut handle = make_active_handle(1, Some("stuck".into()));
        if let QueryState::Active { query, .. } = &mut handle.state {
            *query = Arc::clone(&runtime);
        }
        sessions.lock().await.insert(81, handle);
        app_state.session_runtimes.bind(81, &sessions).await;
        app_state.active_turns.begin_turn(81, &sessions).await;
        app_state.session_status_tx.broadcast_running(81, 1);
        let generation = app_state.active_turns.current_generation(81).await;
        let status_rx = app_state.session_status_tx.subscribe();

        let (ws_tx, mut ws_rx) = tokio::sync::mpsc::unbounded_channel();
        app_state.ws_feature_senders.register(1, ws_tx).await;

        StopWatch::builder()
            .app_state(app_state.clone())
            .sessions(sessions.clone())
            .query(Arc::downgrade(&runtime))
            .db_session_id(81)
            .feature_id(1)
            .maybe_generation(generation)
            .status_rx(status_rx)
            .grace(Duration::from_millis(50))
            .build()
            .run_escalation()
            .await;

        assert!(terminated.load(Ordering::SeqCst));
        assert!(
            !app_state.session_status_tx.is_busy(81),
            "watchdog must guarantee the session settles to Idle"
        );
        assert!(
            matches!(sessions.lock().await[&81].state, QueryState::Pending(_)),
            "force settlement must retire the dead Active handle to Pending for resume"
        );
        let mut actions = Vec::new();
        while let Ok(Message::Text(text)) = ws_rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            actions.push(v["action"].as_str().unwrap_or_default().to_string());
        }
        assert!(actions.contains(&"ended".to_string()), "{actions:?}");
        assert!(actions.contains(&"error".to_string()), "{actions:?}");
    }

    #[tokio::test]
    async fn watchdog_treats_pending_nonblocking_gate_as_settled_without_killing_runtime() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 85, 1).await;
        let sessions = new_sdk_sessions();
        let terminated = Arc::new(AtomicBool::new(false));
        let runtime: RuntimeSessionHandle =
            Arc::new(tokio::sync::RwLock::new(Box::new(StuckRuntime {
                terminated: Arc::clone(&terminated),
                can_terminate: true,
            })));
        app_state.active_turns.begin_turn(85, &sessions).await;
        let generation = app_state.active_turns.current_generation(85).await;
        app_state.session_status_tx.broadcast_running(85, 1);
        let status_rx = app_state.session_status_tx.subscribe();

        // Turn stops cooperatively and leaves a non-blocking question gate open.
        app_state.active_turns.end_turn(85).await;
        app_state.session_status_tx.broadcast_gate_left_pending(
            85,
            1,
            PendingKind::Question,
            "q-1".into(),
        );

        StopWatch::builder()
            .app_state(app_state.clone())
            .query(Arc::downgrade(&runtime))
            .db_session_id(85)
            .feature_id(1)
            .maybe_generation(generation)
            .status_rx(status_rx)
            .grace(Duration::from_millis(50))
            .build()
            .run_escalation()
            .await;

        assert!(
            !terminated.load(Ordering::SeqCst),
            "watchdog must never kill a runtime parked on a pending non-blocking gate"
        );
        assert!(
            app_state.session_status_tx.is_waiting_on_gate(85),
            "pending gate status must be preserved"
        );
    }

    #[tokio::test]
    async fn watchdog_does_not_terminate_a_newer_generation() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let terminated = Arc::new(AtomicBool::new(false));
        let runtime: RuntimeSessionHandle =
            Arc::new(tokio::sync::RwLock::new(Box::new(StuckRuntime {
                terminated: Arc::clone(&terminated),
                can_terminate: true,
            })));
        app_state.active_turns.begin_turn(82, &sessions).await;
        let old_generation = app_state.active_turns.current_generation(82).await;
        app_state.session_status_tx.broadcast_running(82, 1);
        let status_rx = app_state.session_status_tx.subscribe();

        app_state.active_turns.begin_turn(82, &sessions).await;

        StopWatch::builder()
            .app_state(app_state.clone())
            .query(Arc::downgrade(&runtime))
            .db_session_id(82)
            .feature_id(1)
            .maybe_generation(old_generation)
            .status_rx(status_rx)
            .grace(Duration::from_millis(40))
            .build()
            .run_escalation()
            .await;

        assert!(
            !terminated.load(Ordering::SeqCst),
            "watchdog must never kill a newer turn generation"
        );
        assert!(app_state.session_status_tx.is_busy(82));
    }

    #[tokio::test]
    async fn ghost_busy_pending_session_is_cleared_on_stop() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 83, 1).await;
        let sessions = new_sdk_sessions();
        let mut handle = make_active_handle(1, None);
        handle.state = QueryState::Pending(RuntimeSpawnConfig::default());
        sessions.lock().await.insert(83, handle);
        app_state.session_status_tx.broadcast_running(83, 1);

        let error = stop_session(&app_state, Some(&sessions), 83)
            .await
            .unwrap_err();
        assert_eq!(error.code, NOTHING_TO_STOP);
        assert!(
            !app_state.session_status_tx.is_busy(83),
            "Stop must clear a ghost busy Pending session"
        );
    }

    #[tokio::test]
    async fn reconcile_orphaned_busy_session_clears_working_but_preserves_gate() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 86, 1).await;
        app_state.session_status_tx.broadcast_running(86, 1);
        reconcile_orphaned_busy_session(&app_state, 86).await;
        assert!(!app_state.session_status_tx.is_busy(86));

        insert_running_session(&app_state, 87, 1).await;
        app_state
            .session_status_tx
            .broadcast_gate(87, 1, PendingKind::Question, "q-orphan".into());
        reconcile_orphaned_busy_session(&app_state, 87).await;
        assert!(app_state.session_status_tx.is_waiting_on_gate(87));
    }

    #[tokio::test]
    async fn nothing_to_interrupt_reconciler_clears_stuck_ghost_busy_state() {
        let app_state = make_test_app_state().await;
        insert_running_session(&app_state, 84, 1).await;
        let sessions = new_sdk_sessions();
        app_state.active_turns.begin_turn(84, &sessions).await;
        let generation = app_state.active_turns.current_generation(84).await;
        app_state.session_status_tx.broadcast_running(84, 1);
        let status_rx = app_state.session_status_tx.subscribe();

        StopWatch::builder()
            .app_state(app_state.clone())
            .db_session_id(84)
            .feature_id(1)
            .maybe_generation(generation)
            .status_rx(status_rx)
            .grace(Duration::from_millis(50))
            .build()
            .spawn_nothing_to_interrupt_reconciler();

        tokio::time::timeout(Duration::from_secs(2), async {
            while app_state.session_status_tx.is_busy(84) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("reconciler must clear stuck ghost busy state");
    }
}
