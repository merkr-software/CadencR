//! Provider-neutral routing for leading-`!` user shell commands.

use std::path::PathBuf;

use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeSessionHandle, RuntimeUserShellStrategy};
use crate::domain::agents::runtime_adapter;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{PromptSendPayload, WsEnvelope};

use super::super::{send_error, QueryState, SdkSessions, WsSender};
use super::prompt_send::PreparedPrompt;
use crate::domain::ws_session::runtime::prompt::user_shell_local::{
    run_cadencr_managed_user_shell, LocalUserShellRequest,
};

struct UserShellTarget {
    feature_id: i64,
    provider_id: String,
    query: Option<RuntimeSessionHandle>,
}

struct UserShellRouteError {
    code: &'static str,
    message: String,
}

impl UserShellRouteError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Return `true` when `prepared` was a user shell command and was fully handled.
pub(in crate::domain::ws_session) async fn maybe_handle_user_shell_prompt(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    prepared: &PreparedPrompt,
) -> bool {
    let Some(parsed_command) = parse_user_shell_command(&prepared.payload.text) else {
        return false;
    };
    if let Err(error) = handle_user_shell_command(
        &envelope.id,
        sender,
        sdk_sessions,
        app_state,
        prepared,
        parsed_command,
    )
    .await
    {
        send_error(sender, &envelope.id, error.code, &error.message);
    }
    true
}

async fn handle_user_shell_command(
    envelope_id: &str,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    prepared: &PreparedPrompt,
    parsed_command: Result<String, &'static str>,
) -> Result<(), UserShellRouteError> {
    let command = parsed_command
        .map_err(|error| UserShellRouteError::new("INVALID_USER_SHELL_COMMAND", error))?;
    if has_attachments(&prepared.payload) {
        return Err(UserShellRouteError::new(
            "USER_SHELL_ATTACHMENTS_UNSUPPORTED",
            "A leading-! shell command cannot include file or image attachments.",
        ));
    }
    prepare_branch_if_requested(
        sender,
        sdk_sessions,
        app_state,
        prepared.db_session_id,
        &prepared.payload,
    )
    .await
    .map_err(|error| UserShellRouteError::new("USER_SHELL_BRANCH_SETUP_FAILED", error))?;
    let target = resolve_target(sdk_sessions, app_state, prepared.db_session_id)
        .await
        .ok_or_else(|| {
            UserShellRouteError::new(
                "SESSION_NOT_FOUND",
                format!(
                    "Session {} not found. Send session.init first.",
                    prepared.db_session_id
                ),
            )
        })?;
    let adapter = runtime_adapter(&target.provider_id).ok_or_else(|| {
        UserShellRouteError::new(
            "UNSUPPORTED_PROVIDER",
            format!(
                "No runtime adapter registered for '{}'.",
                target.provider_id
            ),
        )
    })?;

    let result = match (adapter.user_shell_strategy(), target.query) {
        (RuntimeUserShellStrategy::ProviderNative, Some(query)) => {
            run_provider_native(&query, &command).await
        }
        (RuntimeUserShellStrategy::ProviderNative, None) => {
            tracing::info!(
                prepared.db_session_id,
                provider = %target.provider_id,
                "native user shell unavailable before runtime spawn; using Cadencr-managed fallback"
            );
            run_local(
                app_state,
                sender,
                envelope_id,
                prepared.db_session_id,
                target.feature_id,
                command,
            )
            .await
        }
        (RuntimeUserShellStrategy::CadencrManaged, _) => {
            run_local(
                app_state,
                sender,
                envelope_id,
                prepared.db_session_id,
                target.feature_id,
                command,
            )
            .await
        }
        (RuntimeUserShellStrategy::Unsupported, _) => Err(format!(
            "Provider '{}' does not support user shell commands.",
            target.provider_id
        )),
    };
    result.map_err(|error| UserShellRouteError::new("USER_SHELL_FAILED", error))
}

fn parse_user_shell_command(text: &str) -> Option<Result<String, &'static str>> {
    let remainder = text.strip_prefix('!')?;
    let command = remainder.trim_start();
    if command.trim().is_empty() {
        return Some(Err("Type a command after `!`."));
    }
    Some(Ok(command.to_string()))
}

fn has_attachments(payload: &PromptSendPayload) -> bool {
    !payload.images.is_empty() || !payload.attachments.is_empty()
}

async fn run_provider_native(query: &RuntimeSessionHandle, command: &str) -> Result<(), String> {
    query
        .read()
        .await
        .run_user_shell_command(command)
        .await
        .map_err(|error| error.to_string())
}

async fn run_local(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    session_id: i64,
    feature_id: i64,
    command: String,
) -> Result<(), String> {
    ensure_session_idle(app_state, session_id).await?;
    let cwd = PathBuf::from(worktree::resolve_feature_cwd(&app_state.read_pool, feature_id).await?);
    let cancellation = app_state.user_shell_runs.register(session_id).await?;
    WsSessionPersistence::mark_running_static(&app_state.write_pool, session_id).await;
    app_state
        .session_status_tx
        .broadcast_running(session_id, feature_id);
    let request = LocalUserShellRequest {
        session_id,
        feature_id,
        command,
        cwd,
        write_pool: app_state.write_pool.clone(),
        sender: sender.clone(),
        feature_senders: app_state.ws_feature_senders.clone(),
        cancellation,
    };
    let app_state = app_state.clone();
    let sender = sender.clone();
    let envelope_id = envelope_id.to_string();
    tokio::spawn(async move {
        let result = run_cadencr_managed_user_shell(request).await;
        app_state.user_shell_runs.unregister(session_id).await;
        WsSessionPersistence::mark_paused_static(&app_state.write_pool, session_id).await;
        WsSessionPersistence::broadcast_session_status(
            &app_state.session_status_tx,
            session_id,
            feature_id,
            crate::domain::session_status::AgentStatus::Idle,
            None,
        );
        if let Err(error) = result {
            super::super::send_error(&sender, &envelope_id, "USER_SHELL_FAILED", &error);
        }
    });
    Ok(())
}

async fn ensure_session_idle(app_state: &AppState, session_id: i64) -> Result<(), String> {
    let status = sqlx::query_scalar::<_, String>("SELECT status FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(&app_state.read_pool)
        .await
        .map_err(|error| format!("Failed to read session status: {error}"))?
        .ok_or_else(|| format!("Session {session_id} not found."))?;
    if status == "running" {
        return Err(
            "Wait for the active agent turn to finish before running a shell command.".to_string(),
        );
    }
    Ok(())
}

async fn resolve_target(
    local: &SdkSessions,
    app_state: &AppState,
    session_id: i64,
) -> Option<UserShellTarget> {
    let effective = crate::domain::ws_session::runtime::control_policy::resolve_owner_sessions(
        local, app_state, session_id,
    )
    .await;
    target_from_sessions(&effective, session_id).await
}

async fn target_from_sessions(sessions: &SdkSessions, session_id: i64) -> Option<UserShellTarget> {
    let sessions = sessions.lock().await;
    let handle = sessions.get(&session_id)?;
    let query = match &handle.state {
        QueryState::Active { query, .. } => Some(query.clone()),
        QueryState::Pending(_) => None,
    };
    Some(UserShellTarget {
        feature_id: handle.feature_id,
        provider_id: handle.runtime_provider.clone(),
        query,
    })
}

async fn prepare_branch_if_requested(
    sender: &WsSender,
    sessions: &SdkSessions,
    app_state: &AppState,
    session_id: i64,
    payload: &PromptSendPayload,
) -> Result<(), String> {
    if !payload.use_worktree.unwrap_or(false) && payload.new_project_branch.is_none() {
        return Ok(());
    }
    let mut sessions = sessions.lock().await;
    let handle = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session {session_id} not found. Send session.init first."))?;
    let QueryState::Pending(options) = &mut handle.state else {
        return Err("Branch setup is only valid before the provider runtime starts.".to_string());
    };
    crate::domain::ws_session::runtime::prompt::prompt_worktree::prepare_branch_provisioning(
        app_state,
        &app_state.write_pool,
        sender,
        payload,
        handle.feature_id,
        &mut handle.config,
        options,
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::parse_user_shell_command;

    #[test]
    fn only_a_leading_bang_selects_user_shell_routing() {
        assert_eq!(
            parse_user_shell_command("! printf ok").unwrap().unwrap(),
            "printf ok"
        );
        assert!(parse_user_shell_command("explain !important").is_none());
        assert!(parse_user_shell_command(" ! pwd").is_none());
        assert!(parse_user_shell_command("!").unwrap().is_err());
    }
}
