use crate::domain::ws_session::protocol::{ModeChangedPayload, WsSessionEvent};
use tracing::error;

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::{AccessModeSetPayload, WsEnvelope};
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    access_mode_wire, parse_access_mode_wire, RuntimeAccessMode, RuntimeError,
};
use crate::domain::agents::runtime_adapter;

async fn apply_active_access_mode(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: &RuntimeAccessMode,
) -> Result<(), RuntimeError> {
    let query = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            return Ok(());
        };
        let applies_in_place = runtime_adapter(&handle.runtime_provider)
            .is_some_and(|adapter| adapter.applies_access_mode_in_place());
        match (&handle.state, applies_in_place) {
            (QueryState::Active { query, .. }, true)
                if handle.desired_access_mode.as_ref() != Some(access_mode) =>
            {
                Some(query.clone())
            }
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

pub(crate) async fn handle_access_mode_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(payload) = parse_payload(&envelope, sender) else {
        return;
    };
    let Some((sdk_sessions, db_session_id, feature_id)) =
        resolve_target(sender, sdk_sessions, app_state, &envelope.id, &payload).await
    else {
        return;
    };
    let Some(access_mode) = parse_access_mode(sender, &envelope.id, &payload.mode) else {
        return;
    };
    if !apply_access_mode(
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
    let mode_wire = access_mode_wire(&access_mode);
    if !persist_access_mode(sender, &envelope.id, app_state, db_session_id, mode_wire).await {
        return;
    }
    update_cached_access_mode(&sdk_sessions, db_session_id, access_mode).await;
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        &WsSessionEvent::AccessModeChanged(ModeChangedPayload {
            mode: mode_wire.into(),
        }),
    )
    .await;
}

fn parse_payload(envelope: &WsEnvelope, sender: &WsSender) -> Option<AccessModeSetPayload> {
    match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => Some(payload),
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            None
        }
    }
}

async fn resolve_target(
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    ref_id: &str,
    payload: &AccessModeSetPayload,
) -> Option<(SdkSessions, i64, i64)> {
    let db_session_id = parse_session_id(&payload.session_id).or_else(|| {
        send_error(sender, ref_id, "INVALID_SESSION_ID", "Invalid session_id");
        None
    })?;
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, &app_state.active_turns, db_session_id).await;
    let feature_id = validate_session(sender, &effective_sessions, ref_id, db_session_id).await?;
    Some((effective_sessions, db_session_id, feature_id))
}

async fn validate_session(
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
    let supports_access = runtime_adapter(&handle.runtime_provider)
        .is_some_and(|adapter| adapter.supports_access_mode(&RuntimeAccessMode::Default));
    if !supports_access {
        send_error(
            sender,
            ref_id,
            "MODE_NOT_SUPPORTED",
            "Access mode is not supported by this provider",
        );
        return None;
    }
    Some(handle.feature_id)
}

fn parse_access_mode(sender: &WsSender, ref_id: &str, raw_mode: &str) -> Option<RuntimeAccessMode> {
    parse_access_mode_wire(raw_mode).or_else(|| {
        send_error(sender, ref_id, "INVALID_PAYLOAD", "Invalid access mode");
        None
    })
}

async fn apply_access_mode(
    sender: &WsSender,
    ref_id: &str,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: &RuntimeAccessMode,
) -> bool {
    if let Err(error) = apply_active_access_mode(sdk_sessions, db_session_id, access_mode).await {
        error!(db_session_id, %error, "failed to apply access mode to active runtime");
        send_error(sender, ref_id, "MODE_REJECTED_BY_CLI", &error.to_string());
        return false;
    }
    true
}

async fn persist_access_mode(
    sender: &WsSender,
    ref_id: &str,
    app_state: &AppState,
    db_session_id: i64,
    mode_wire: &str,
) -> bool {
    if let Err(error) = WsSessionPersistence::update_access_mode_static(
        &app_state.write_pool,
        db_session_id,
        mode_wire,
    )
    .await
    {
        error!(db_session_id, %error, "failed to persist access mode");
        send_error(sender, ref_id, "DB_ERROR", "Failed to persist access mode");
        return false;
    }
    true
}

async fn update_cached_access_mode(
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    access_mode: RuntimeAccessMode,
) {
    let mut sessions = sdk_sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return;
    };
    // When the live runtime already adopted the whole change in place and its
    // launch flags are unchanged (Cursor Default <-> Auto Review), advance
    // `spawned_access_mode` too so the next prompt doesn't force a redundant
    // respawn. Launch-flag changes (Full Access) leave `spawned` stale so the
    // respawn path still re-launches with the right flags.
    let needs_respawn = runtime_adapter(&handle.runtime_provider).is_none_or(|adapter| {
        adapter.access_mode_change_needs_respawn(handle.spawned_access_mode.as_ref(), &access_mode)
    });
    handle.desired_access_mode = Some(access_mode.clone());
    handle.config.access_mode = Some(access_mode.clone());
    if !needs_respawn {
        handle.spawned_access_mode = Some(access_mode.clone());
    }
    if let QueryState::Pending(options) = &mut handle.state {
        options.access_mode = Some(access_mode);
    }
}
