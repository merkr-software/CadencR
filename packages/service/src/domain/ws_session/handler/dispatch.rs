//! Domain-level dispatch: route a `WsEnvelope` to the matching per-domain
//! and per-action handler. Kept separate from the connection loop so the
//! routing table is the only thing that grows when new actions land.

use axum::extract::ws::Message;
use tracing::info;

use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{SessionErrorPayload, WsEnvelope};

use super::types::{SdkSessions, WsSender};
use super::{
    app, commands, session_branch, session_compact, session_control, session_data, session_gate,
    session_init, session_prompt,
};

/// Dispatch an envelope to the appropriate domain handler.
pub(super) async fn dispatch_envelope(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    info!(domain = %envelope.domain, action = %envelope.action, id = %envelope.id, "received envelope");
    match envelope.domain.as_str() {
        "session" => {
            handle_session_action(envelope, sender, sdk_sessions, app_state).await;
        }
        "commands" => {
            commands::handle_commands_action(envelope, sender).await;
        }
        "app" => {
            app::handle_app_action(envelope, sender, app_state).await;
        }
        unknown => {
            let err = WsEnvelope::reply(
                &envelope.id,
                "session",
                "error",
                serde_json::to_value(SessionErrorPayload {
                    code: "UNKNOWN_DOMAIN".into(),
                    message: format!("Unknown domain: {unknown}"),
                    ..Default::default()
                })
                .unwrap(),
            );
            let _ = sender.send(Message::Text(String::from(err).into()));
        }
    }
}

/// Handle session domain actions.
async fn handle_session_action(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    match envelope.action.as_str() {
        "init" => session_init::handle_init(envelope, sender, sdk_sessions, app_state).await,
        "prompt.send" => {
            session_prompt::handle_prompt_send(envelope, sender, sdk_sessions, app_state).await
        }
        "permission.respond" => {
            session_control::handle_permission_respond(envelope, sender, sdk_sessions, app_state)
                .await
        }
        "gate.close" => {
            session_gate::handle_gate_close(envelope, sender, sdk_sessions, app_state).await
        }
        "provider.set" => {
            session_control::handle_provider_set(envelope, sender, sdk_sessions, app_state).await
        }
        "model.set" => {
            session_control::handle_model_set(envelope, sender, sdk_sessions, app_state).await
        }
        "mode.set" => {
            session_control::handle_mode_set(envelope, sender, sdk_sessions, app_state).await
        }
        "codex_permission_mode.set" => {
            session_control::handle_codex_permission_mode_set(
                envelope,
                sender,
                sdk_sessions,
                app_state,
            )
            .await
        }
        "effort.set" => {
            session_control::handle_effort_set(envelope, sender, sdk_sessions, app_state).await
        }
        "profile.set" => {
            session_control::handle_profile_set(envelope, sender, sdk_sessions, app_state).await
        }
        "interrupt" => {
            session_control::handle_interrupt(envelope, sender, sdk_sessions, app_state).await
        }
        "branch.rewind" => {
            session_branch::handle_rewind(envelope, sender, sdk_sessions, app_state).await
        }
        "branch.fork" => {
            session_branch::handle_fork(envelope, sender, sdk_sessions, app_state).await
        }
        "suspend" => {
            session_control::handle_suspend(envelope, sender, sdk_sessions, app_state).await
        }
        "resume" => session_control::handle_resume(envelope, sender).await,
        "destroy" => {
            session_control::handle_destroy(envelope, sender, sdk_sessions, app_state).await
        }
        "compact" => {
            session_compact::handle_compact(envelope, sender, sdk_sessions, app_state).await
        }
        "delete" => session_control::handle_delete(envelope, sender, sdk_sessions, app_state).await,
        "clear" => session_control::handle_clear(envelope, sender, sdk_sessions, app_state).await,
        "history.get" => session_data::handle_history_get(envelope, sender, app_state).await,
        "history.add" => session_data::handle_history_add(envelope, sender, app_state).await,
        "draft.get" => session_data::handle_draft_get(envelope, sender, app_state).await,
        "draft.save" => session_data::handle_draft_save(envelope, sender, app_state).await,
        "retry_worktree_setup" => {
            session_control::handle_retry_worktree_setup(envelope, sender, app_state).await
        }
        unknown => {
            let err = WsEnvelope::reply(
                &envelope.id,
                "session",
                "error",
                serde_json::to_value(SessionErrorPayload {
                    code: "UNKNOWN_ACTION".into(),
                    message: format!("Unknown session action: {unknown}"),
                    ..Default::default()
                })
                .unwrap(),
            );
            let _ = sender.send(Message::Text(String::from(err).into()));
        }
    }
}
