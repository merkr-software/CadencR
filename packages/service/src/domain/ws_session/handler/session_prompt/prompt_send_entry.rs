use super::prompt_send_pending::spawn_pending_prompt;
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::WsEnvelope;

use super::super::{send_error, SdkSessions, WsSender};
use super::prompt_send::{dispatch_local_phase, dispatch_owner_phase, prepare_prompt};
use crate::domain::ws_session::runtime::prompt::prompt_selection_sync;

/// Handle `session.prompt.send` through local, remote-owner, then spawn phases.
pub(crate) async fn handle_prompt_send(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(prepared) = prepare_prompt(&envelope, sender, sdk_sessions, app_state).await else {
        return;
    };
    match crate::domain::prompt_queue::acceptance::defer_if_required(
        app_state,
        prepared.db_session_id,
        &prepared.payload,
    )
    .await
    {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            send_error(
                sender,
                &envelope.id,
                error.coded_error_or("PROMPT_QUEUE_ERROR"),
                &error.to_string(),
            );
            return;
        }
    }
    if super::user_shell::maybe_handle_user_shell_prompt(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        &prepared,
    )
    .await
    {
        return;
    }
    // Handles may hold a stale model; both dispatch phases adopt the row's.
    let stored =
        match prompt_selection_sync::load(&app_state.read_pool, prepared.db_session_id).await {
            Ok(stored) => stored,
            Err((code, message)) => return send_error(sender, &envelope.id, code, &message),
        };
    let Some(payload) = dispatch_local_phase()
        .envelope(&envelope)
        .sender(sender)
        .sdk_sessions(sdk_sessions)
        .app_state(app_state)
        .db_session_id(prepared.db_session_id)
        .payload(prepared.payload)
        .maybe_profile_update(prepared.profile_update.as_ref())
        .stored(&stored)
        .call()
        .await
    else {
        return;
    };
    let Some(payload) = dispatch_owner_phase(
        &envelope,
        sender,
        app_state,
        prepared.db_session_id,
        payload,
        prepared.profile_update.as_ref(),
        &stored,
    )
    .await
    else {
        return;
    };
    spawn_pending_prompt(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        prepared.db_session_id,
        payload,
    )
    .await;
}

pub(super) fn report_prompt_result(
    sender: &WsSender,
    envelope_id: &str,
    result: Result<(), String>,
) {
    if let Err(error) = result {
        send_error(sender, envelope_id, "USER_MESSAGE_PERSIST_FAILED", &error);
    }
}
