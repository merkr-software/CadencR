//! `branch.rewind` — roll a session's conversation **and** code back to the
//! state before a chosen user message, in place. The chosen message's text is
//! returned as a draft (NOT sent) so the user can edit and re-send.

use tracing::{info, warn};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::WsEnvelope;
use super::super::helpers::send_error;
use super::super::types::{SdkSessions, WsSender};
use super::rewind_state::{apply_rewind_state, RewindStateError};
use super::{
    current_runtime_session_id, load_inputs, parse_payload, reply_and_broadcast, report_abort,
    stop_live_turn, truncate_context, BranchInputs,
};
use crate::app_state::AppState;
use crate::domain::checkpoints;
use crate::domain::session_status::AgentStatus;

/// Handle `session.branch.rewind`.
pub(crate) async fn handle_rewind(
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

    // Code rewind is available only when a pre-turn checkpoint exists. A DB
    // failure must NOT be read as "no checkpoint" — that would quietly skip the
    // code restore. Surface it instead.
    let checkpoint =
        match checkpoints::get_commit_sha(&app_state.read_pool, inputs.message_id).await {
            Ok(sha) => sha,
            Err(error) => return send_error(sender, &envelope.id, "DB_ERROR", &error.to_string()),
        };

    // Confirm gate: a checkpoint restore discards everything in the worktree
    // since the snapshot. If the worktree is dirty and the user hasn't confirmed,
    // ask first — never discard silently.
    if checkpoint.is_some() && !payload.confirm_discard && worktree_dirty(&inputs).await {
        let reply = WsEnvelope::reply(
            &envelope.id,
            "session",
            "branch.needs_confirm",
            serde_json::json!({
                "sessionId": db_session_id.to_string(),
                "messageId": inputs.message_id,
                "kind": "rewind",
                "reason": "Rewinding will discard uncommitted changes since this message.",
            }),
        );
        let _ = sender.send(axum::extract::ws::Message::Text(String::from(reply).into()));
        return;
    }

    // Stop any live turn before mutating (interrupt + close, reset to Pending).
    stop_live_turn(sdk_sessions, app_state, db_session_id).await;
    let source_runtime_session_id =
        current_runtime_session_id(&app_state.read_pool, db_session_id).await;

    // (context) Branch the provider transcript FIRST. If the provider can't
    // branch or surgery fails, abort here — none of the destructive steps (code
    // restore, message deletion, runtime-id swap) have run, so nothing is left
    // half-rewound. The live turn was already interrupted above, which is an
    // expected consequence of initiating a rewind.
    let new_runtime_session_id = match truncate_context(&inputs, source_runtime_session_id).await {
        Ok(outcome) => outcome.into_session_id(),
        Err(abort) => return report_abort(sender, &envelope.id, abort),
    };

    // (code + db) Restore code before deleting conversation rows. If a
    // checkpoint exists but cannot be restored, abort before DB mutation so the
    // conversation is never rewound without the corresponding code state.
    let code_outcome = match apply_rewind_state(
        &app_state.write_pool,
        &inputs,
        checkpoint.as_deref(),
        new_runtime_session_id.as_deref(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(RewindStateError::CodeRestore(reason)) => {
            send_error(sender, &envelope.id, "CODE_RESTORE_FAILED", &reason);
            return;
        }
        Err(RewindStateError::Db(error)) => {
            send_error(sender, &envelope.id, "DB_ERROR", &error.to_string());
            return;
        }
    };
    let (code_restored, code_restore_error) = code_outcome.to_wire();

    finish_rewind(
        app_state,
        sender,
        &envelope.id,
        db_session_id,
        &inputs,
        new_runtime_session_id.is_some(),
        code_restored,
        code_restore_error,
    )
    .await;
}

async fn finish_rewind(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    inputs: &BranchInputs,
    truncated: bool,
    code_restored: bool,
    code_restore_error: Option<String>,
) {
    persist_rewind_draft(app_state, db_session_id, inputs).await;

    WsSessionPersistence::broadcast_session_status(
        &app_state.session_status_tx,
        db_session_id,
        inputs.feature_id,
        AgentStatus::Idle,
        None,
    );

    info!(
        db_session_id,
        message_id = inputs.message_id,
        code_restored,
        truncated,
        "rewind complete"
    );

    reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        inputs.feature_id,
        "branch.rewound",
        serde_json::json!({
            "sessionId": db_session_id.to_string(),
            "messageId": inputs.message_id,
            "draftText": inputs.message_text,
            "codeRestored": code_restored,
            "codeRestoreError": code_restore_error,
        }),
    )
    .await;
}

async fn persist_rewind_draft(app_state: &AppState, db_session_id: i64, inputs: &BranchInputs) {
    // Restore the cut message's text into the composer (unsent). The composer
    // restores from `feature_settings.draft_prompt` (the same store fork
    // writes), so persist there for it to survive a reload; also mirror it to
    // `agent_sessions.draft_prompt` for the session-scoped readers.
    if let Err(error) = crate::domain::workflow::worktree::set_setting(
        &app_state.write_pool,
        inputs.feature_id,
        "draft_prompt",
        &inputs.message_text,
    )
    .await
    {
        warn!(db_session_id, error = %error, "failed to persist rewind draft to feature settings");
    }
    if let Err(error) = crate::domain::sessions::repository::save_draft(
        &app_state.write_pool,
        db_session_id,
        Some(&inputs.message_text),
    )
    .await
    {
        warn!(db_session_id, error = %error, "failed to persist rewind draft");
    }
}

async fn worktree_dirty(inputs: &BranchInputs) -> bool {
    match checkpoints::is_dirty(&inputs.cwd).await {
        Ok(dirty) => dirty,
        Err(error) => {
            // Couldn't probe the worktree — fail safe toward the confirm prompt
            // rather than silently discarding changes we couldn't verify.
            warn!(
                inputs.db_session_id,
                error = %error,
                "could not check worktree status; requiring confirmation before discarding"
            );
            true
        }
    }
}
