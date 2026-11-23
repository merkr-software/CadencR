//! Where a prompt sent to a live runtime stands between its arrival and its
//! hand-over: whether a Stop cancelled it, and which turn a withdrawal ends.
//!
//! A prompt that arrives while a turn runs follows that turn (see
//! `runtime::followup_stops`). One that finds the session idle reserves its own
//! turn as soon as it is persisted, before its pre-turn checkpoint: every
//! client sees the session working (and its Stop) at once, a prompt sent
//! meanwhile from another device follows it instead of starting a second turn,
//! and a Stop in that window cancels it before the runtime has it.

use std::sync::Arc;

use super::super::ActiveTurnRegistry;
use super::followup_withdrawal::end_turn_idle;
use super::prompt_followup::FollowupPromptContext;
use super::prompt_status::mark_agent_running;
use crate::domain::session_status::SessionStatusBroadcaster;
use crate::domain::ws_session::runtime::followup_stops::{
    AcceptedFollowup, IdleArrival, ReservedStart,
};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

/// The turn a prompt sent while idle reserved.
struct TurnStart {
    active_turns: Arc<ActiveTurnRegistry>,
    session_id: i64,
    feature_id: i64,
    reserved: ReservedStart,
    /// The logical turn `mark_agent_running` began for it.
    generation: Option<u64>,
    /// Taken back from the reserved starts: this prompt alone settles the turn.
    owned: bool,
    /// What ending the turn idle needs if the prompt is dropped first.
    write_pool: sqlx::SqlitePool,
    feature_senders: WsFeatureSenderRegistry,
    status: SessionStatusBroadcaster,
}

impl TurnStart {
    /// Whether this prompt settles its turn: it takes the start back while it
    /// is still reserved. A Stop or a sleep pause that cancelled it ended the
    /// turn itself.
    fn own(&mut self) -> bool {
        if !self.owned {
            self.owned = self
                .active_turns
                .followups()
                .take_start(self.session_id, self.reserved);
        }
        self.owned
    }

    fn pending(&self) -> bool {
        self.active_turns
            .followups()
            .start_pending(self.session_id, self.reserved)
    }
}

impl Drop for TurnStart {
    /// A prompt that ends before its hand-over no longer holds the start: a
    /// later Stop must not take it for one. When nothing settled the turn it
    /// marked working (its task was cancelled: the socket closed, a remote
    /// device was revoked), that turn ends idle. A prompt that reported an
    /// error already left the session paused, and is left alone.
    fn drop(&mut self) {
        if self.owned || !self.own() {
            return;
        }
        let Some(generation) = self.generation else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(
                self.session_id,
                "a cancelled prompt's turn could not be ended: the runtime is gone"
            );
            return;
        };
        let (active_turns, pool, senders, status) = (
            self.active_turns.clone(),
            self.write_pool.clone(),
            self.feature_senders.clone(),
            self.status.clone(),
        );
        let (session_id, feature_id) = (self.session_id, self.feature_id);
        runtime.spawn(async move {
            if !status.is_busy(session_id) {
                return;
            }
            end_turn_idle()
                .pool(&pool)
                .feature_senders(&senders)
                .status(&status)
                .active_turns(&active_turns)
                .session_id(session_id)
                .feature_id(feature_id)
                .generation(generation)
                .call()
                .await;
        });
    }
}

pub(super) struct FollowupDelivery {
    /// A refused steer leaves the running turn alone (control callers).
    pub(super) preserve_running_turn: bool,
    /// Sent while a turn ran: a user Stop after it cancels it.
    pub(super) accepted: Option<AcceptedFollowup>,
    /// Sent while idle: the turn it reserved.
    start: Option<TurnStart>,
}

impl FollowupDelivery {
    /// On arrival. A prompt sent while a turn runs is that turn's follow-up
    /// from now on, so a Stop sent while it is persisted cancels it too.
    pub(super) fn arrive(context: &FollowupPromptContext) -> Self {
        let turn_running = context.session_status_tx.is_busy(context.db_session_id);
        Self {
            preserve_running_turn: context.wait_for_delivery && turn_running,
            accepted: turn_running.then(|| {
                context
                    .active_turns
                    .followups()
                    .accept(context.db_session_id)
            }),
            start: None,
        }
    }

    /// Once persisted, before the order lock and the pre-turn checkpoint. A
    /// prompt that found the session idle reserves its turn and marks the
    /// session working, or follows the turn another prompt started meanwhile.
    /// Either way a Stop now acts on it, so the controls received after it may
    /// run.
    pub(super) async fn reserve_turn(&mut self, context: &FollowupPromptContext) {
        if self.accepted.is_none() {
            let id = context.db_session_id;
            let busy = context.session_status_tx.is_busy(id);
            match context.active_turns.followups().arrive_idle(id, busy) {
                IdleArrival::Follows(accepted) => {
                    self.accepted = Some(accepted);
                    self.preserve_running_turn = context.wait_for_delivery;
                }
                IdleArrival::Starts(reserved) => {
                    let start = self.start.insert(TurnStart {
                        active_turns: context.active_turns.clone(),
                        session_id: id,
                        feature_id: context.feature_id,
                        reserved,
                        generation: None,
                        owned: false,
                        write_pool: context.write_pool.clone(),
                        feature_senders: context.ws_feature_senders.clone(),
                        status: context.session_status_tx.clone(),
                    });
                    mark_running(context).await;
                    start.generation = context.active_turns.current_generation(id).await;
                    let followups = context.active_turns.followups();
                    followups.set_start_generation(id, reserved, start.generation);
                }
            }
        }
        crate::domain::ws_session::handler::let_controls_through();
    }

    /// Whether a Stop cancelled it since it arrived.
    pub(super) fn cancelled(&self, context: &FollowupPromptContext) -> bool {
        if let Some(start) = &self.start {
            return !start.owned && !start.pending();
        }
        self.accepted.is_some_and(|accepted| {
            context
                .active_turns
                .followups()
                .stopped_since(context.db_session_id, accepted)
        })
    }

    /// Right before the hand-over, under the runtime's turn barrier: whether it
    /// may go. A reserved start becomes this prompt's turn, which a Stop from
    /// now on interrupts like any running turn. When another turn began since
    /// the reservation (a follow-up handed over first, and may have ended),
    /// the session is marked working again for the turn this prompt starts.
    pub(super) async fn claim_hand_over(&mut self, context: &FollowupPromptContext) -> bool {
        let Some(start) = &mut self.start else {
            return !self.cancelled(context);
        };
        if !start.own() {
            return false;
        }
        let id = context.db_session_id;
        if context.active_turns.current_generation(id).await != start.generation {
            mark_running(context).await;
            start.generation = context.active_turns.current_generation(id).await;
        }
        true
    }

    /// Whether it follows a running turn (the others start their own).
    pub(super) fn follows_a_turn(&self) -> bool {
        self.start.is_none()
    }

    /// The turn a withdrawal must end itself. A follow-up sent mid-turn needs
    /// none: the Stop interrupted that turn, whose end settles the session
    /// (settling it earlier would close the turn before its stop marker). A
    /// reserved start a Stop cancelled was ended by that Stop. One this prompt
    /// still holds, or the runtime dropped, started the only turn.
    pub(super) fn turn_to_end(&mut self) -> Option<u64> {
        let start = self.start.as_mut()?;
        start.own().then_some(start.generation).flatten()
    }
}

/// Mark the session working for the turn `context`'s prompt starts.
pub(super) async fn mark_running(context: &FollowupPromptContext) {
    mark_agent_running(
        &context.write_pool,
        &context.session_status_tx,
        &context.ws_feature_senders,
        &context.active_turns,
        &context.sdk_sessions,
        context.db_session_id,
        context.feature_id,
    )
    .await;
}
