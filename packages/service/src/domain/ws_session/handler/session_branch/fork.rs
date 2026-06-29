//! `branch.fork` — branch a session's **conversation** into a brand-new
//! *feature* that shares the source feature's worktree. The new feature keeps
//! only the context before a chosen user message, carries a freshly-branched
//! provider transcript, and surfaces the chosen message's text as a draft in
//! its composer (NOT sent). There is no code rollback: the new feature points
//! at the *same* worktree directory as the source (both then edit the same
//! files — see the design doc). Making the fork a new feature gives it a
//! first-class view + sidebar entry, so the originating client can navigate
//! straight to it.

use tracing::info;

use super::super::super::protocol::WsEnvelope;
use super::super::helpers::send_error;
use super::super::types::{SdkSessions, WsSender};
use super::fork_db::create_forked_feature;
use super::{
    current_runtime_session_id, load_inputs, parse_payload, reply_and_broadcast, report_abort,
    stop_live_turn, truncate_context,
};
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;

/// Handle `session.branch.fork`.
pub(crate) async fn handle_fork(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some((payload, db_session_id)) = parse_payload(&envelope, sender) else {
        return;
    };
    let inputs = match load_inputs(&app_state.read_pool, db_session_id, payload.message_id).await {
        Ok(inputs) => inputs,
        Err(abort) => return report_abort(sender, &envelope.id, abort),
    };

    // Stop any live turn so the on-disk transcript is consistent before surgery.
    // The source session's conversation rows are left untouched.
    stop_live_turn(sdk_sessions, app_state, db_session_id).await;
    let source_runtime_session_id =
        current_runtime_session_id(&app_state.read_pool, db_session_id).await;

    // Branch the provider transcript (no code restore — shared worktree). If the
    // provider can't branch or surgery fails, abort *before* creating the fork
    // feature — never spawn a fork that silently resumes the full source history.
    let new_runtime_session_id = match truncate_context(&inputs, source_runtime_session_id).await {
        Ok(outcome) => outcome.into_session_id(),
        Err(abort) => return report_abort(sender, &envelope.id, abort),
    };

    let fork = match create_forked_feature(
        &app_state.write_pool,
        db_session_id,
        inputs.feature_id,
        inputs.message_id,
        &inputs.message_text,
        new_runtime_session_id.as_deref(),
    )
    .await
    {
        Ok(fork) => fork,
        Err(error) => {
            send_error(sender, &envelope.id, "DB_ERROR", &error.to_string());
            return;
        }
    };

    // A brand-new feature appeared — tell every connected client to refresh its
    // sidebar so the fork shows up (the originating client also navigates to it).
    app_state.feature_events_tx.emit(
        fork.new_feature_id,
        Some(fork.project_id),
        FeatureEventAction::Created,
    );

    info!(
        source_session_id = db_session_id,
        new_feature_id = fork.new_feature_id,
        new_session_id = fork.new_session_id,
        message_id = inputs.message_id,
        truncated = new_runtime_session_id.is_some(),
        "fork complete"
    );

    reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        inputs.feature_id,
        "branch.forked",
        serde_json::json!({
            "sourceSessionId": db_session_id.to_string(),
            "newSessionId": fork.new_session_id.to_string(),
            "newFeatureId": fork.new_feature_id,
            "projectId": fork.project_id,
            "draftText": inputs.message_text,
        }),
    )
    .await;
}
