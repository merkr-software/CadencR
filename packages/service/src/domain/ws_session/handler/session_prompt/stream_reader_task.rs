use std::collections::HashSet;

use axum::extract::ws::Message;
use tokio::time::Instant;
use tracing::{debug, info};

use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeMessageRx, RuntimeSessionWeakHandle,
};
use crate::domain::agents::{runtime_adapter, runtime_session_finished};
use crate::domain::runtime_stream::{RuntimeUsageSnapshot, RuntimeUsageState};
use crate::domain::session_status::{AgentStatus, SessionStatusBroadcaster};
use crate::domain::usage_stats::{TurnWordUsage, UsageAttribution};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{SessionEndedPayload, WsEnvelope};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::{persist_and_close_query, QueryState, SdkSessions, WsSender};
use super::stream_reader_resume::transition_active_to_pending_on_stream_end;
use super::stream_reader_stop;
use super::stream_reader_turn_state::StreamTurnState;

/// Debounce provider completion checks long enough for normal events to arrive.
const PROVIDER_RECONCILE_IDLE: std::time::Duration = std::time::Duration::from_millis(750);

pub(super) struct StreamReaderTask {
    pub db_session_id: i64,
    pub feature_id: i64,
    pub message_rx: RuntimeMessageRx,
    /// Exact runtime instance whose receiver this task owns. Used during
    /// teardown so an older interrupted reader cannot replace a newly resumed
    /// runtime's `Active` handle with `Pending`.
    pub runtime_session_handle: Option<RuntimeSessionWeakHandle>,
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
    pub(super) runtime_session_id: Option<String>,
    pub(super) usage_state: RuntimeUsageState,
    /// Words the agent has produced since the last flush, for the long-lived
    /// provider usage stats. Flushed on every turn-ending `Result` and once
    /// more when the reader stops, so an interrupted or aborted turn still
    /// contributes what it produced instead of being dropped.
    pub(super) word_usage: TurnWordUsage,
    /// Provider/model/effort captured when the current batch of words started
    /// arriving. The session row is mutable while a turn runs — switching model
    /// mid-stream persists immediately — so reading it at flush time would file
    /// the turn's output under a model that produced none of it, and split it
    /// from its own prompt. Cleared by every flush.
    pub(super) usage_attribution: Option<UsageAttribution>,
    pub(super) last_runtime_activity: Instant,
    pub(super) last_provider_reconcile: Instant,
    pub(super) turn_state: StreamTurnState,
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
    /// Monotonic counter stamped onto every `session.message` envelope this
    /// reader emits, so clients can detect a dropped envelope (gap) and
    /// resync. Restarts at 1 with each reader; clients treat a lower-than-
    /// expected value as a stream restart, not a gap.
    pub(super) message_seq: u64,
    /// Prompt receipts emitted during the current logical turn. They are also
    /// repeated on `session.ended` so the terminal envelope repairs a missed
    /// transient acknowledgement on the client.
    pub(super) received_prompt_message_uuids: Vec<String>,
    /// Bounded wire tap of the raw provider events this reader saw, dumped to
    /// a file when the turn ends abnormally so the surfaced error can point at
    /// evidence (issue #78).
    pub(super) diagnostics: super::stream_diagnostics::StreamDiagnostics,
}

enum ReaderAction {
    Continue,
    Break,
    Event(RuntimeEvent),
    Error(RuntimeError),
    Closed,
}

impl StreamReaderState {
    fn new(initial_usage: RuntimeUsageSnapshot) -> Self {
        Self {
            runtime_session_id: None,
            usage_state: RuntimeUsageState::new(initial_usage),
            word_usage: TurnWordUsage::default(),
            usage_attribution: None,
            last_runtime_activity: Instant::now(),
            last_provider_reconcile: Instant::now(),
            turn_state: StreamTurnState::new(),
            live_background_agents: HashSet::new(),
            message_seq: 0,
            received_prompt_message_uuids: Vec::new(),
            diagnostics: super::stream_diagnostics::StreamDiagnostics::new(),
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
        let initial_usage = self.initial_usage_snapshot().await;
        let runtime_adapter = runtime_adapter(&self.runtime_provider);
        let mut persistence = WsSessionPersistence::with_session_id(
            self.write_pool.clone(),
            self.feature_id,
            Some(self.db_session_id),
        );
        let mut state = StreamReaderState::new(initial_usage);

        loop {
            match self.next_action(&mut state).await {
                ReaderAction::Continue => continue,
                ReaderAction::Break => break,
                ReaderAction::Closed => {
                    self.handle_reader_closed(&mut state).await;
                    break;
                }
                ReaderAction::Error(error) => {
                    self.handle_reader_error(&mut state, error).await;
                    break;
                }
                ReaderAction::Event(runtime_event) => {
                    if self.discard_superseded_event().await {
                        break;
                    }
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

        // Whatever the last turn produced after its final flush point (an
        // interrupt, an abort, or a stream that ended without a `Result`) still
        // counts as words the provider sent us.
        self.flush_word_usage(&mut state).await;

        transition_active_to_pending_on_stream_end(
            &self.sdk_sessions,
            self.db_session_id,
            self.runtime_session_handle.as_ref(),
            self.cleanup_session_on_end,
        )
        .await;
    }

    /// Capture what this batch of words should be attributed to, the first time
    /// the agent produces any.
    ///
    /// Taken here rather than at flush time because the session's model and
    /// effort can change while the turn is still streaming. One small query per
    /// turn — it stays `Some` until the flush that clears it, so the token path
    /// only re-reads once a new batch starts.
    pub(super) async fn capture_usage_attribution(&self, state: &mut StreamReaderState) {
        if state.usage_attribution.is_some() || state.word_usage.pending() == 0 {
            return;
        }
        state.usage_attribution =
            crate::domain::usage_stats::snapshot_attribution(&self.write_pool, self.db_session_id)
                .await;
    }

    /// Fold the words accumulated so far into the long-lived provider usage
    /// stats, under the attribution captured when they started arriving.
    ///
    /// Hands the write itself to a background task; runs once per turn, not per
    /// delta, so it is not on the token hot path.
    pub(super) async fn flush_word_usage(&self, state: &mut StreamReaderState) {
        let words = state.word_usage.take();
        let attribution = state.usage_attribution.take();
        if words == 0 {
            return;
        }
        match attribution {
            Some(attribution) => crate::domain::usage_stats::record_words_attributed(
                &self.write_pool,
                attribution,
                0,
                words,
            ),
            // No snapshot only if the words arrived without passing the capture
            // point; the session's current attribution is the best answer left.
            None => {
                crate::domain::usage_stats::record_session_words(
                    &self.write_pool,
                    self.db_session_id,
                    0,
                    words,
                )
                .await
            }
        }
    }

    /// Seed the usage state from what the session already shows: the persisted
    /// token totals plus the best known window. Carrying the totals (rather
    /// than starting at zero) is what lets a window-only update be emitted
    /// mid-flight without blanking the bar.
    async fn initial_usage_snapshot(&self) -> RuntimeUsageSnapshot {
        let row = WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await;
        let persisted = |value: Option<i64>| value.and_then(|v| u64::try_from(v).ok()).unwrap_or(0);

        let context_window = match self.provider_context_window {
            Some(cw) if cw > 0 => Some(cw),
            _ => row
                .as_ref()
                .and_then(|row| row.context_window)
                .and_then(|cw| u64::try_from(cw).ok())
                .filter(|cw| *cw > 0),
        };

        RuntimeUsageSnapshot {
            input_tokens: persisted(row.as_ref().and_then(|row| row.input_tokens)),
            output_tokens: persisted(row.as_ref().and_then(|row| row.output_tokens)),
            context_window,
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
        let Some(runtime_sid) = state.runtime_session_id.clone() else {
            return ReaderAction::Continue;
        };
        if runtime_session_finished(&self.runtime_provider, &runtime_sid).await {
            self.reconcile_provider_completion(&runtime_sid, state)
                .await;
            return ReaderAction::Break;
        }
        ReaderAction::Continue
    }

    /// A clean stream close (no SDK error) is *unexpected* when the DB still
    /// says a turn is running and no live background agent is still expected
    /// to emit follow-up events. That covers both mid-turn EOF and the #78
    /// shape where the CLI exits before emitting even its first runtime event.
    ///
    /// Intentional teardowns (destroy/clear/suspend) move DB status off
    /// `running` first, so stopping a conversation on purpose never raises a
    /// spurious error.
    /// Mirrors the `turn_running` guard in [`should_close_orphaned`].
    pub(super) async fn stream_close_was_unexpected(&self, state: &StreamReaderState) -> bool {
        if !stream_reader_stop::stream_close_needs_running_status(
            state.turn_state.is_between_turns(),
            !state.live_background_agents.is_empty(),
            state.turn_state.has_error_surfaced_this_turn(),
        ) {
            return false;
        }

        let session_running =
            WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id)
                .await
                .is_some_and(|row| row.status == "running");
        stream_reader_stop::stream_close_was_unexpected(
            state.turn_state.is_between_turns(),
            !state.live_background_agents.is_empty(),
            state.turn_state.has_error_surfaced_this_turn(),
            session_running,
        )
    }

    async fn reconcile_provider_completion(
        &self,
        runtime_sid: &str,
        state: &mut StreamReaderState,
    ) {
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
                received_prompt_message_uuids: std::mem::take(
                    &mut state.received_prompt_message_uuids,
                ),
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
        if !(state.turn_state.is_between_turns() && state.turn_state.has_completed_turn()) {
            return false;
        }
        let row = WsSessionPersistence::get_session_row(&self.write_pool, self.db_session_id).await;
        let has_pending_user_input = row.as_ref().is_some_and(|row| row.has_pending_user_input());
        // A `running` status means another device just dispatched a follow-up
        // into this same turn; don't close it out from under that new turn.
        let turn_running = row.is_some_and(|row| row.status == "running");
        if !should_close_orphaned(
            state.turn_state.is_between_turns(),
            state.turn_state.has_completed_turn(),
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
    state.last_runtime_activity.elapsed() >= PROVIDER_RECONCILE_IDLE
        && state.last_provider_reconcile.elapsed() >= PROVIDER_RECONCILE_IDLE
}

#[cfg(test)]
mod tests {
    use super::should_close_orphaned;

    #[test]
    fn closes_only_when_between_turns_after_a_result_with_no_pending_gate() {
        assert!(should_close_orphaned(true, true, false, false));
    }

    #[test]
    fn never_closes_mid_turn() {
        assert!(!should_close_orphaned(false, true, false, false));
    }

    #[test]
    fn never_closes_before_first_turn_completes() {
        assert!(!should_close_orphaned(true, false, false, false));
    }

    #[test]
    fn keeps_runtime_alive_while_a_gate_is_pending() {
        assert!(!should_close_orphaned(true, true, true, false));
    }

    #[test]
    fn never_closes_while_a_cross_device_followup_is_starting() {
        assert!(!should_close_orphaned(true, true, false, true));
    }
}
