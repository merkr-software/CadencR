//! Shared pre-turn checkpoint capture for the first-turn and follow-up prompt
//! handlers.
//!
//! The worktree snapshot is a deliberate *pre-turn barrier* (see
//! [`crate::domain::checkpoints::capture_pre_turn`]): it must finish before the
//! prompt reaches the agent so the checkpoint captures the pre-edit tree. It is
//! best-effort and time-bounded, so it never hangs a turn. Checkpoints are
//! provider-neutral — every provider gets them, since code rewind is not
//! Claude-specific.

use std::path::Path;

use super::prompt_followup::FollowupPromptContext;
use super::prompt_pending::PendingPromptContext;

/// First-turn capture: the worktree cwd is already provisioned + re-resolved on
/// the context, so snapshot it directly.
pub(super) async fn capture_pre_turn_pending(
    context: &PendingPromptContext,
    message_id: Option<i64>,
) {
    let Some(message_id) = message_id else {
        return;
    };
    crate::domain::checkpoints::capture_pre_turn(
        &context.app_state.write_pool,
        &context.config.cwd,
        context.feature_id,
        message_id,
    )
    .await;
}

/// Follow-up capture: resolve the cwd from the DB (the follow-up context carries
/// none) — the worktree when one exists, else the project folder — so a
/// non-worktree feature still gets a per-turn checkpoint for rewind.
pub(super) async fn capture_pre_turn_followup(
    context: &FollowupPromptContext,
    message_id: Option<i64>,
) {
    let Some(message_id) = message_id else {
        return;
    };
    let Ok(path) = crate::domain::workflow::worktree::resolve_feature_cwd(
        &context.write_pool,
        context.feature_id,
    )
    .await
    else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    crate::domain::checkpoints::capture_pre_turn(
        &context.write_pool,
        Path::new(&path),
        context.feature_id,
        message_id,
    )
    .await;
}
