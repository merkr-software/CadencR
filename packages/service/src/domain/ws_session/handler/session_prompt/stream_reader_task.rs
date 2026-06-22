use std::collections::HashSet;

use axum::extract::ws::Message;
use tokio::time::Instant;
use tracing::{debug, info};

use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeMessageRx};
use crate::domain::agents::{runtime_adapter, runtime_session_finished};
use crate::domain::runtime_stream::RuntimeUsageState;
use crate::domain::session_status::{AgentStatus, SessionStatusBroadcaster};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{SessionEndedPayload, WsEnvelope};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::{persist_and_close_query, QueryState, SdkSessions, WsSender};
use super::stream_reader_resume::transition_active_to_pending_on_stream_end;

pub(super) struct StreamReaderTask {
    pub db_session_id: i64,
    pub feature_id: i64,
    pub message_rx: RuntimeMessageRx,
    pub sender: WsSender,
    /// Other devices viewing the same feature; every owner-bound stream message
    /// is mirrored to them via [`StreamReaderTask::send_and_mirror`].
    pub feature_senders: WsFeatureSenderRegistry,
    pub write_pool: sqlx::SqlitePool,
    pub session_status_tx: SessionStatusBroadcaster,
    pub sdk_sessions: SdkSessions,
    pub runtime_provider: String,
    pub provider_context_window: Option<u64>,
    pub app_state: AppState,
    pub cleanup_session_on_end: bool,
}

pub(super) struct StreamReaderState {
    pub(super) needs_session_id_capture: bool,
    pub(super) runtime_session_id: Option<String>,
    pub(super) usage_state: RuntimeUsageState,
    pub(super) last_runtime_activity: Instant,
    pub(super) last_provider_reconcile: Instant,
    pub(super) last_signal_status: Option<AgentStatus>,
    pub(super) between_turns: bool,
    /// Set once the first turn emits a `result`. Gates deferred teardown so a
    /// just-started turn (whose first event hasn't arrived yet, so
    /// `between_turns` is still its initial `true`) is never torn down.
    pub(super) saw_result: bool,
    /// True while the runtime is inside a provider-reported compaction turn.
    pub(super) compacting: bool,
    /// Opaque handles of background (run-in-background) agents that have
    /// started but not yet finished. Non-empty means the session is still
    /// working even though the launching turn's `Result` has arrived, so the
    /// turn-complete path must keep it `running` instead of going idle (issue
    /// #58). Keyed by [`BackgroundAgentSignal`](crate::domain::agents::adapter::BackgroundAgentSignal)'s `agent_id`.
    ///
    /// Entries are released on the agent's terminal `task_notification` (the
    /// "came to rest" signal), matched permissively by `is_terminal_task_status`
    /// so an unforeseen terminal label still drains the set. If that signal is
    /// ever missed entirely, the stale entry keeps the session "working" only
    /// until this reader's stream closes, which drops the whole state — it never
    /// pins across reconnects. We accept that bounded risk rather than add a
    /// timer/TTL: over-holding the spinner for one stream is recoverable, and a
    /// premature eviction (e.g. on a nested-agent `MessageStart`) would wrongly
    /// drop it mid-run.
    pub(super) live_background_agents: HashSet<String>,
}

enum ReaderAction {
    Continue,
    Break,
    Event(RuntimeEvent),
    Error(RuntimeError),
    Closed,
}

impl StreamReaderState {
    fn new(initial_context_window: Option<u64>) -> Self {
        Self {
            needs_session_id_capture: true,
            runtime_session_id: None,
            usage_state: RuntimeUsageState::new(initial_context_window),
            last_runtime_activity: Instant::now(),
            last_provider_reconcile: Instant::now(),
            last_signal_status: None,
            between_turns: true,
            saw_result: false,
            compacting: false,
            live_background_agents: HashSet::new(),
        }
    }
}

/// The owner connection has gone. The orphaned runtime is closed only once the
/// turn is genuinely between turns (`between_turns`), at least one turn has
/// completed (`saw_result`, so a just-started turn isn't killed), no
/// permission/question gate is pending (a reconnecting device could still
/// answer it), and the DB does not show a turn `running`. The last guard closes
/// the race where another device (e.g. the host) has just dispatched a
/// cross-device follow-up — `mark_agent_running` has set status `running`, but
/// the provider hasn't emitted the first event yet so `between_turns` is still
/// its post-result `true`. Pure so it is unit-testable without a live runtime.
fn should_close_orphaned(
    between_turns: bool,
    saw_result: bool,
    has_pending_user_input: bool,
    turn_running: bool,
) -> bool {
    between_turns && saw_result && !has_pending_user_input && !turn_running
}

impl StreamReaderTask {
    /// Send `msg` to this turn's owner socket and mirror it to any *other*
    /// devices viewing the same feature. Others are mirrored first so the owner
    /// send can move `msg` without a clone; in the common single-viewer case
    /// `broadcast_others` is a no-op. Returns `true` when the owner socket is
    /// gone, so callers can stop the loop exactly as a bare `send().is_err()`.
    pub(super) async fn send_and_mirror(&self, msg: Message) -> bool {
        self.feature_senders
            .send_and_mirror(self.feature_id, &self.sender, msg)
            .await
    }

    pub async fn run(mut self) {
        info!(self.db_session_id, "stream reader started");
        let initial_context_window = self.initial_context_window().await;
        let runtime_adapter = runtime_adapter(&self.runtime_provider);
        let mut persistence = WsSessionPersistence::with_session_id(
            self.write_pool.clone(),
            self.feature_id,
            Some(self.db_session_id),
        );
        let mut state = StreamReaderState::new(initial_context_window);

        loop {
            match self.next_action(&mut state).await {
                ReaderAction::Continue => continue,
                ReaderAction::Break => break,
                ReaderAction::Closed => {
                    self.send_stream_closed().await;
                    break;
                }
                ReaderAction::Error(error) => {
                    self.handle_stream_error(error).await;
                    break;
                }
                ReaderAction::Event(runtime_event) => {
                    self.handle_runtime_event(
                        &mut state,
                        runtime_adapter,
                        &mut persistence,
                        runtime_event,
                    )
                    .await;
                }
            }
        }

        transition_active_to_pending_on_stream_end(&self.sdk_sessions, self.db_session_id).await;
        if self.cleanup_session_on_end {
            self.sdk_sessions.lock().await.remove(&self.db_session_id);
        }
    }

    async fn initial_context_window(&self) -> Option<u64> {
        match self.provider_context_window {
            Some(cw) if cw > 0 => Some(cw),
            _ => WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id)
                .await
                .and_then(|row| row.context_window)
                .and_then(|cw| u64::try_from(cw).ok())
                .filter(|cw| *cw > 0),
        }
    }

    async fn next_action(&mut self, state: &mut StreamReaderState) -> ReaderAction {
        let recv_result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            self.message_rx.recv(),
        )
        .await;

        match recv_result {
            Ok(Some(Ok(runtime_event))) => ReaderAction::Event(runtime_event),
            Ok(Some(Err(error))) => ReaderAction::Error(error),
            Ok(None) => ReaderAction::Closed,
            Err(_) => self.handle_timeout_tick(state).await,
        }
    }

    async fn handle_timeout_tick(&self, state: &mut StreamReaderState) -> ReaderAction {
        // Keepalive ping to the turn owner. A failed send means the owner socket
        // is gone (e.g. a remote phone went to sleep). Unlike before, that does
        // NOT end the turn — the agent keeps running on the host. Only once the
        // turn has gone idle between turns with the owner still gone can the
        // runtime no longer be driven from here, so we close it (persisting the
        // resume id) and stop. A reconnecting device continues via --resume.
        let owner_gone = self.sender.send(Message::Ping(vec![].into())).is_err();
        if owner_gone && self.maybe_teardown_orphaned(state).await {
            debug!(
                self.db_session_id,
                "owner gone and turn idle; closed orphaned runtime"
            );
            return ReaderAction::Break;
        }
        if !should_reconcile_provider(state) {
            return ReaderAction::Continue;
        }
        state.last_provider_reconcile = Instant::now();
        let Some(runtime_sid) = state.runtime_session_id.as_deref() else {
            return ReaderAction::Continue;
        };
        if runtime_session_finished(&self.runtime_provider, runtime_sid).await {
            self.reconcile_provider_completion(runtime_sid).await;
            return ReaderAction::Break;
        }
        ReaderAction::Continue
    }

    async fn reconcile_provider_completion(&self, runtime_sid: &str) {
        info!(
            self.db_session_id,
            runtime_session_id = runtime_sid,
            "provider reports finished session; reconciling completion"
        );
        WsSessionPersistence::mark_completed_static(&self.write_pool, self.db_session_id).await;
        WsSessionPersistence::broadcast_session_status(
            &self.session_status_tx,
            self.db_session_id,
            self.feature_id,
            AgentStatus::Idle,
            None,
        );
        let end_env = WsEnvelope::new(
            "session",
            "ended",
            serde_json::to_value(SessionEndedPayload {
                reason: "provider_complete".into(),
            })
            .unwrap(),
        );
        let _ = self
            .send_and_mirror(Message::Text(String::from(end_env).into()))
            .await;
    }

    /// Tear down a runtime whose owner connection has gone, but only when the
    /// turn is safely between turns (see [`should_close_orphaned`]). Returns
    /// `true` when the runtime was closed and the reader should stop.
    async fn maybe_teardown_orphaned(&self, state: &StreamReaderState) -> bool {
        // Cheap pre-check before the DB read: never tear down mid-turn or before
        // the first turn has completed.
        if !(state.between_turns && state.saw_result) {
            return false;
        }
        let row = WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await;
        let has_pending_user_input = row.as_ref().is_some_and(|row| row.has_pending_user_input());
        // A `running` status means another device just dispatched a follow-up
        // into this same turn; don't close it out from under that new turn.
        let turn_running = row.is_some_and(|row| row.status == "running");
        if !should_close_orphaned(
            state.between_turns,
            state.saw_result,
            has_pending_user_input,
            turn_running,
        ) {
            return false;
        }
        self.close_orphaned_runtime().await;
        true
    }

    /// Persist the runtime session id (so the conversation resumes intact),
    /// close the subprocess, and announce the session idle. Mirrors what the
    /// connection-disconnect path used to do eagerly — now deferred until the
    /// in-flight turn has actually finished.
    async fn close_orphaned_runtime(&self) {
        let query = {
            let sessions = self.sdk_sessions.lock().await;
            match sessions
                .get(&self.db_session_id)
                .map(|handle| &handle.state)
            {
                Some(QueryState::Active { query, .. }) => Some(query.clone()),
                _ => None,
            }
        };
        if let Some(query) = query {
            persist_and_close_query(
                &query,
                &self.write_pool,
                self.db_session_id,
                &self.runtime_provider,
            )
            .await;
        }
        WsSessionPersistence::mark_paused_static(&self.write_pool, self.db_session_id).await;
        WsSessionPersistence::broadcast_session_status(
            &self.session_status_tx,
            self.db_session_id,
            self.feature_id,
            AgentStatus::Idle,
            None,
        );
    }
}

fn should_reconcile_provider(state: &StreamReaderState) -> bool {
    state.last_runtime_activity.elapsed() >= std::time::Duration::from_millis(750)
        && state.last_provider_reconcile.elapsed() >= std::time::Duration::from_millis(750)
}

#[cfg(test)]
mod tests {
    use super::should_close_orphaned;

    #[test]
    fn closes_only_when_between_turns_after_a_result_with_no_pending_gate() {
        // Owner gone, a turn has completed, nothing pending, no running turn →
        // safe to close.
        assert!(should_close_orphaned(true, true, false, false));
    }

    #[test]
    fn never_closes_mid_turn() {
        // A turn is actively running (not between turns).
        assert!(!should_close_orphaned(false, true, false, false));
    }

    #[test]
    fn never_closes_before_first_turn_completes() {
        // `between_turns` is still its initial `true` but no result yet — a
        // just-started turn must not be torn down out from under itself.
        assert!(!should_close_orphaned(true, false, false, false));
    }

    #[test]
    fn keeps_runtime_alive_while_a_gate_is_pending() {
        // A reconnecting device could still answer the permission/question.
        assert!(!should_close_orphaned(true, true, true, false));
    }

    #[test]
    fn never_closes_while_a_cross_device_followup_is_starting() {
        // Between turns after a result, but the DB shows `running`: another
        // device dispatched a follow-up whose first event hasn't arrived yet.
        // Closing here would kill that just-started turn (the race from the
        // remote-disconnect → host-follow-up flow).
        assert!(!should_close_orphaned(true, true, false, true));
    }
}
