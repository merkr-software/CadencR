use super::prompt_send_pending::spawn_pending_prompt;
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::WsEnvelope;

use super::super::{send_error, SdkHandle, SdkSessions, WsSender};
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
                "PROMPT_QUEUE_ERROR",
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
    let Some(payload) = dispatch_local_phase(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        prepared.db_session_id,
        prepared.payload,
        prepared.profile_update.as_ref(),
        &stored,
    )
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

/// The provider/model a user-typed prompt is about to run on.
pub(in crate::domain::ws_session) struct PromptedSelection {
    provider_id: String,
    model_id: Option<String>,
}

impl PromptedSelection {
    pub(in crate::domain::ws_session) fn of(handle: &SdkHandle) -> Self {
        Self {
            provider_id: handle.runtime_provider.clone(),
            model_id: handle.desired_model.clone(),
        }
    }
}

/// Report whether the prompt's user message was persisted. An accepted prompt
/// makes its pair the workspace's last-used selection — the one the next new
/// conversation starts on — off the prompt path. Schedules and MCP spawns
/// dispatch through the control path, so they never move it.
pub(in crate::domain::ws_session) fn report_prompt_result(
    sender: &WsSender,
    envelope_id: &str,
    selection: PromptedSelection,
    result: Result<(), String>,
) {
    if let Err(error) = result {
        send_error(sender, envelope_id, "USER_MESSAGE_PERSIST_FAILED", &error);
        return;
    }
    let sender = sender.clone();
    let envelope_id = envelope_id.to_string();
    tokio::spawn(async move {
        let remembered = crate::domain::agents::selection::remember_session_selection(
            &selection.provider_id,
            selection.model_id.as_deref(),
        )
        .await;
        if let Err(error) = remembered {
            send_error(
                &sender,
                &envelope_id,
                "LAST_USED_MODEL_SAVE_FAILED",
                &format!("Couldn't remember this model for new conversations: {error}"),
            );
        }
    });
}
