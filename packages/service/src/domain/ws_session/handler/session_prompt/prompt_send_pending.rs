use super::super::{send_error, QueryState, SdkSessions, WsSender};
use super::prompt_send::build_followup_context;
use super::prompt_send_entry::{report_prompt_result, PromptedSelection};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{PromptSendPayload, WsEnvelope};
use crate::domain::ws_session::runtime::prompt::prompt_followup::handle_followup_prompt;
use crate::domain::ws_session::runtime::prompt::prompt_pending::{
    handle_pending_prompt, PendingPromptContext,
};
use tracing::{debug, info};

/// First prompt (or respawn after a config change): take the stored spawn
/// options off this connection's `Pending` handle and start the runtime.
pub(in crate::domain::ws_session) async fn spawn_pending_prompt(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    payload: PromptSendPayload,
) {
    let spawn_claim = app_state.session_runtimes.claim_spawn(db_session_id).await;
    if !session_still_exists(app_state, db_session_id, sender, &envelope.id).await {
        return;
    }

    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        send_error(
            sender,
            &envelope.id,
            "SESSION_NOT_FOUND",
            &format!("Session {db_session_id} not found. Send session.init first."),
        );
        return;
    };
    let selection = PromptedSelection::of(handle);
    let spawned_model = handle.desired_model.clone();
    let spawned_thinking_effort = handle.desired_thinking_effort.clone();
    let config = handle.config.clone();
    let feature_id = handle.feature_id;
    let provider_id = handle.runtime_provider.clone();
    let mut options = match &handle.state {
        QueryState::Pending(opts) => opts.clone(),
        QueryState::Active { query, .. } => {
            let context = build_followup_context(
                query.clone(),
                handle.identity.begin_delivery(),
                feature_id,
                db_session_id,
                provider_id,
                sender,
                sdk_sessions,
                app_state,
                envelope.id.clone(),
            );
            drop(sessions);
            drop(spawn_claim);
            let result = handle_followup_prompt(context, payload).await;
            report_prompt_result(sender, &envelope.id, selection, result);
            return;
        }
    };

    // Use the runtime session ID captured at init time for --resume.
    if options.resume_session_id.is_none() {
        if let Some(runtime_sid) = handle.resume_session_id.clone() {
            info!(db_session_id, runtime_session_id = %runtime_sid, "resuming previous runtime session");
            options.resume_session_id = Some(runtime_sid);
        } else {
            debug!(
                db_session_id,
                feature_id, "no runtime_session_id found, spawning fresh"
            );
        }
    }
    let context = PendingPromptContext {
        envelope_id: envelope.id.clone(),
        sender: sender.clone().into(),
        sdk_sessions: sdk_sessions.clone(),
        app_state: app_state.clone(),
        db_session_id,
        feature_id,
        provider_id,
        spawned_model,
        spawned_thinking_effort,
        config,
        options,
        payload,
        permission_tx: None,
        internal_replay: false,
        wait_for_delivery: false,
        spawn_claim: Some(spawn_claim),
        handle_identity: handle.identity.clone(),
    };
    drop(sessions);
    // Persist user message in the pending helper after releasing sdk_sessions.
    let result = handle_pending_prompt(context).await;
    report_prompt_result(sender, &envelope.id, selection, result);
}

async fn session_still_exists(
    app_state: &AppState,
    db_session_id: i64,
    sender: &WsSender,
    correlation_id: &str,
) -> bool {
    match crate::domain::ws_session::persistence::WsSessionPersistence::try_get_session_row(
        &app_state.read_pool,
        db_session_id,
    )
    .await
    {
        Ok(Some(_)) => true,
        Ok(None) => {
            send_error(
                sender,
                correlation_id,
                "SESSION_NOT_FOUND",
                "Session was deleted before prompt dispatch",
            );
            false
        }
        Err(error) => {
            send_error(sender, correlation_id, "DB_ERROR", &error.to_string());
            false
        }
    }
}
