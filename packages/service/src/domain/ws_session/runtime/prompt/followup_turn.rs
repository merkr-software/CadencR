//! What a prompt sent to a live runtime holds from its pre-turn checkpoint to
//! its hand-over.
//!
//! Prompts of one session go in FIFO order (`lock_followup_delivery`). The
//! pre-turn checkpoint runs under that order lock only, never under the
//! runtime's turn barrier, so a Stop is never held behind it. Since nothing
//! holds the runtime meanwhile, a rewind, a fork or a close may replace it: the
//! prompt then reads the session cell again and is withdrawn instead of being
//! streamed to a closed runtime.

use tokio::sync::{OwnedMutexGuard, OwnedRwLockReadGuard};

use crate::domain::agents::adapter::AgentRuntimeSession;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::followup_delivery::FollowupDelivery;
use super::followup_withdrawal::{withdraw_followup, WithdrawnBy};
use super::prompt_followup::FollowupPromptContext;

pub(super) struct FollowupTurnGuard {
    pub(super) runtime: OwnedRwLockReadGuard<Box<dyn AgentRuntimeSession>>,
    _barrier: Option<OwnedMutexGuard<()>>,
    pub(super) followup_order: Option<OwnedMutexGuard<()>>,
}

/// Serialize back-to-back prompts in FIFO order, capture the pre-turn git
/// checkpoint without holding the runtime, then hold the runtime (if it is
/// still the session's) and its turn barrier. `Ok(None)`: a Stop or a runtime
/// replacement withdrew the prompt.
pub(super) async fn acquire_followup_turn_guard(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    message_id: Option<i64>,
    dispatch_claim: Option<&(i64, String)>,
    delivery: &mut FollowupDelivery,
) -> Result<Option<FollowupTurnGuard>, String> {
    let followup_order = context
        .active_turns
        .lock_followup_delivery(context.db_session_id)
        .await;
    if delivery.cancelled(context) {
        drop(followup_order);
        withdraw(
            context,
            payload,
            dispatch_claim,
            delivery,
            WithdrawnBy::Stop,
        )
        .await?;
        return Ok(None);
    }

    // Snapshot the worktree *before* this turn's prompt is delivered to the live
    // agent (`stream_input`), so a later rewind to this message can restore the
    // pre-turn code state. A deliberate pre-turn barrier.
    super::prompt_checkpoint::capture_pre_turn_followup(context, message_id).await;

    // Retain this read guard through dispatch. Reacquiring it while holding
    // the barrier could deadlock against a queued writer and another control.
    let Some(runtime) = read_current_runtime(context).await else {
        drop(followup_order);
        let by = WithdrawnBy::RuntimeReplaced;
        withdraw(context, payload, dispatch_claim, delivery, by).await?;
        return Ok(None);
    };
    let barrier = runtime.turn_control_guard().await;
    let turn_guard = FollowupTurnGuard {
        runtime,
        _barrier: barrier,
        followup_order: Some(followup_order),
    };
    // Before it starts a turn: a Stop that came meanwhile ended the one it
    // followed (or cancelled the one it reserved), and nothing would end the
    // turn it starts.
    if delivery.cancelled(context) {
        drop(turn_guard);
        withdraw(
            context,
            payload,
            dispatch_claim,
            delivery,
            WithdrawnBy::Stop,
        )
        .await?;
        return Ok(None);
    }
    Ok(Some(turn_guard))
}

async fn withdraw(
    context: &FollowupPromptContext,
    payload: &PromptSendPayload,
    dispatch_claim: Option<&(i64, String)>,
    delivery: &mut FollowupDelivery,
    by: WithdrawnBy,
) -> Result<(), String> {
    let started_turn = delivery.turn_to_end();
    withdraw_followup(context, payload, None, dispatch_claim, started_turn, by).await
}

/// Hold the prompt's runtime while it is still the one its session cell runs.
/// Read under the cell lock, so no rewind, fork or close swaps it out between
/// the check and the read guard; once held, a close waits for the hand-over.
async fn read_current_runtime(
    context: &FollowupPromptContext,
) -> Option<OwnedRwLockReadGuard<Box<dyn AgentRuntimeSession>>> {
    let sessions = context.sdk_sessions.lock().await;
    let current = sessions
        .get(&context.db_session_id)
        .is_some_and(|handle| handle.state.runs(Some(&context.query)));
    if !current {
        return None;
    }
    Some(context.query.clone().read_owned().await)
}
