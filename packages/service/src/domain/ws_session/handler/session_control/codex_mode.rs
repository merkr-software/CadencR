use tracing::error;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::{CodexPermissionModeSetPayload, WsEnvelope};
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimeError};
use crate::domain::agents::codex::{
    access_mode_wire, parse_access_mode_wire, PROVIDER_ID as CODEX_PROVIDER_ID,
};

async fn apply_active_codex_access_mode(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: &RuntimeAccessMode,
) -> Result<(), RuntimeError> {
    let query = {
        let sessions = sdk_sessions.lock().await;
        match sessions.get(&db_session_id) {
            Some(handle) if handle.desired_access_mode.as_ref() == Some(access_mode) => None,
            Some(handle) => match &handle.state {
                QueryState::Active { query, .. } => Some(query.clone()),
                QueryState::Pending(_) => None,
            },
            _ => None,
        }
    };
    if let Some(query) = query {
        query
            .read()
            .await
            .set_access_mode(access_mode.clone())
            .await?;
    }
    Ok(())
}

pub(crate) async fn handle_codex_permission_mode_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(payload) = parse_codex_permission_payload(&envelope, sender) else {
        return;
    };
    let Some((sdk_sessions, db_session_id, feature_id)) =
        resolve_codex_permission_target(sender, sdk_sessions, app_state, &envelope.id, &payload)
            .await
    else {
        return;
    };
    let Some(access_mode) = parse_codex_access_mode(sender, &envelope.id, &payload.mode) else {
        return;
    };
    let mode_wire = access_mode_wire(&access_mode);

    if !apply_codex_access_mode(
        sender,
        &envelope.id,
        &sdk_sessions,
        db_session_id,
        &access_mode,
    )
    .await
    {
        return;
    }
    if !persist_codex_access_mode(sender, &envelope.id, app_state, db_session_id, mode_wire).await {
        return;
    }
    update_cached_codex_access_mode(&sdk_sessions, db_session_id, access_mode).await;

    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        "codex_permission_mode.changed",
        serde_json::json!({ "mode": mode_wire }),
    )
    .await;
}

fn parse_codex_permission_payload(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<CodexPermissionModeSetPayload> {
    match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => Some(payload),
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            None
        }
    }
}

async fn resolve_codex_permission_target(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    ref_id: &str,
    payload: &CodexPermissionModeSetPayload,
) -> Option<(SdkSessions, i64, i64)> {
    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(sender, ref_id, "INVALID_SESSION_ID", "Invalid session_id");
            return None;
        }
    };
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let feature_id =
        validate_codex_session(sender, &effective_sessions, ref_id, db_session_id).await?;
    Some((effective_sessions, db_session_id, feature_id))
}

async fn validate_codex_session(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    ref_id: &str,
    db_session_id: i64,
) -> Option<i64> {
    let sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get(&db_session_id) else {
        send_error(sender, ref_id, "SESSION_NOT_FOUND", "Session not found");
        return None;
    };
    if handle.runtime_provider != CODEX_PROVIDER_ID {
        send_error(
            sender,
            ref_id,
            "MODE_NOT_SUPPORTED",
            "Codex access mode can only be changed on Codex sessions",
        );
        return None;
    }
    Some(handle.feature_id)
}

fn parse_codex_access_mode(
    sender: &WsSender,
    ref_id: &str,
    raw_mode: &str,
) -> Option<RuntimeAccessMode> {
    match parse_access_mode_wire(raw_mode) {
        Some(access_mode) => Some(access_mode),
        None => {
            send_error(
                sender,
                ref_id,
                "INVALID_PAYLOAD",
                "Invalid Codex access mode",
            );
            None
        }
    }
}

async fn apply_codex_access_mode(
    sender: &WsSender,
    ref_id: &str,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: &RuntimeAccessMode,
) -> bool {
    if let Err(error) =
        apply_active_codex_access_mode(sdk_sessions, db_session_id, access_mode).await
    {
        error!(db_session_id, %error, "failed to apply Codex access mode to active runtime");
        send_error(sender, ref_id, "MODE_REJECTED_BY_CLI", &error.to_string());
        return false;
    }
    true
}

async fn persist_codex_access_mode(
    sender: &WsSender,
    ref_id: &str,
    app_state: &AppState,
    db_session_id: i64,
    mode_wire: &str,
) -> bool {
    if let Err(error) = WsSessionPersistence::update_codex_permission_mode_static(
        &app_state.write_pool,
        db_session_id,
        mode_wire,
    )
    .await
    {
        error!(db_session_id, %error, "failed to persist Codex permission mode");
        send_error(
            sender,
            ref_id,
            "DB_ERROR",
            "Failed to persist Codex permission mode",
        );
        return false;
    }
    true
}

async fn update_cached_codex_access_mode(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: RuntimeAccessMode,
) {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return;
    };
    handle.desired_access_mode = Some(access_mode.clone());
    handle.config.access_mode = Some(access_mode.clone());
    if let QueryState::Pending(options) = &mut handle.state {
        options.access_mode = Some(access_mode);
    }
}
