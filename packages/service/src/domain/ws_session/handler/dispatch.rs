//! Domain-level dispatch: route a `WsEnvelope` to the matching per-domain
//! and per-action handler. Kept separate from the connection loop so the
//! routing table is the only thing that grows when new actions land.

use tracing::info;

use crate::app_state::AppState;
use crate::domain::ws_session::protocol::{
    canonical_session_command_action, WsEnvelope, WsSessionCommandAction as Command,
};

use super::helpers::send_error;
use super::types::{SdkSessions, WsSender};
use super::{
    app, commands, session_branch, session_compact, session_control as control, session_data,
    session_gate, session_init, session_prompt,
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
        unknown => send_error(
            sender,
            &envelope.id,
            "UNKNOWN_DOMAIN",
            &format!("Unknown domain: {unknown}"),
        ),
    }
}

/// Handle session domain actions.
async fn handle_session_action(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(action) = canonical_session_command_action(&envelope.action) else {
        send_error(
            sender,
            &envelope.id,
            "UNKNOWN_ACTION",
            &format!("Unknown session action: {}", envelope.action),
        );
        return;
    };
    match action {
        Command::Init => session_init::handle_init(envelope, sender, sdk_sessions, app_state).await,
        Command::PromptSend => {
            session_prompt::handle_prompt_send(envelope, sender, sdk_sessions, app_state).await
        }
        Command::PermissionRespond => {
            control::handle_permission_respond(envelope, sender, sdk_sessions, app_state).await
        }
        Command::GateClose => {
            session_gate::handle_gate_close(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ProviderSet => {
            control::handle_provider_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ModelSet => {
            control::handle_model_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ModeSet => {
            control::handle_mode_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::AccessModeSet => {
            control::handle_access_mode_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::EffortSet => {
            control::handle_effort_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ConfigGet => {
            control::handle_session_config_get(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ConfigSet => {
            control::handle_session_config_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::FastModeSet => {
            control::handle_fast_mode_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::ProfileSet => {
            control::handle_profile_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::RuntimeOverridesSet => {
            control::handle_runtime_overrides_set(envelope, sender, sdk_sessions, app_state).await
        }
        Command::Interrupt => {
            control::handle_interrupt(envelope, sender, sdk_sessions, app_state).await
        }
        Command::BranchRewind => {
            session_branch::handle_rewind(envelope, sender, sdk_sessions, app_state).await
        }
        Command::BranchFork => {
            session_branch::handle_fork(envelope, sender, sdk_sessions, app_state).await
        }
        Command::Suspend => {
            control::handle_suspend(envelope, sender, sdk_sessions, app_state).await
        }
        Command::Resume => control::handle_resume(envelope, sender).await,
        Command::Destroy => {
            control::handle_destroy(envelope, sender, sdk_sessions, app_state).await
        }
        Command::Compact => {
            session_compact::handle_compact(envelope, sender, sdk_sessions, app_state).await
        }
        Command::Delete => control::handle_delete(envelope, sender, sdk_sessions, app_state).await,
        Command::Clear => control::handle_clear(envelope, sender, sdk_sessions, app_state).await,
        Command::HistoryGet => session_data::handle_history_get(envelope, sender, app_state).await,
        Command::HistoryAdd => session_data::handle_history_add(envelope, sender, app_state).await,
        Command::DraftGet => session_data::handle_draft_get(envelope, sender, app_state).await,
        Command::DraftSave => session_data::handle_draft_save(envelope, sender, app_state).await,
        Command::RetryWorktreeSetup => {
            control::handle_retry_worktree_setup(envelope, sender, app_state).await
        }
    }
}
