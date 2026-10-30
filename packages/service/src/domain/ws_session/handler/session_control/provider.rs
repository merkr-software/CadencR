use axum::extract::ws::Message;
use tracing::error;

use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{SdkSessions, WsSender};
use super::session_has_messages;
use crate::app_state::AppState;
use crate::domain::agents::runtime_adapter;

mod persistence;
mod selection;
mod switch;
pub(crate) use persistence::{read_persisted_selection, restore_persisted_selection};
use selection::SwitchSelection;
use switch::ProviderSetError;

/// Reject the switch before the first prompt is even possible: unparseable
/// payloads, unknown providers, and sessions that already have history.
async fn validate_provider_set(
    payload: &ProviderSetPayload,
    db_session_id: i64,
    app_state: &AppState,
) -> Result<(), ProviderSetError> {
    if runtime_adapter(&payload.provider).is_none() {
        return Err(ProviderSetError::new(
            "UNSUPPORTED_PROVIDER",
            format!(
                "Runtime provider '{}' is not implemented yet",
                payload.provider
            ),
        ));
    }
    let has_messages = session_has_messages(&app_state.read_pool, db_session_id)
        .await
        .map_err(|error| {
            error!(db_session_id, %error, "failed to verify session history before provider change");
            ProviderSetError::new("DB_ERROR", "Failed to verify session history")
        })?;
    if has_messages {
        return Err(ProviderSetError::locked());
    }
    Ok(())
}

/// Handle session.provider.set: change the provider before the first prompt only.
pub(crate) async fn handle_provider_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: ProviderSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "Invalid session_id",
        );
        return;
    };

    if let Err(error) = apply_provider_set(
        &envelope,
        sender,
        sdk_sessions,
        app_state,
        &payload,
        db_session_id,
    )
    .await
    {
        send_error(sender, &envelope.id, error.code, &error.message);
    }
}

async fn apply_provider_set(
    envelope: &WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    payload: &ProviderSetPayload,
    db_session_id: i64,
) -> Result<(), ProviderSetError> {
    validate_provider_set(payload, db_session_id, app_state).await?;
    let snapshot = switch::snapshot(sdk_sessions, db_session_id).await?;
    if snapshot.unchanged(payload) {
        let reply = WsEnvelope::session_reply(
            &envelope.id,
            &WsSessionEvent::ProviderSetOk(selection::reply(
                &payload.provider,
                &snapshot.into_runtime(),
            )),
        )
        .expect("provider selection serializes");
        let _ = sender.send(Message::Text(String::from(reply).into()));
        return Ok(());
    }
    let selection = selection::resolve(app_state, payload, snapshot).await?;
    let reply = selection::reply(&selection.provider, &selection.runtime);
    let mode = selection
        .provider_changed
        .then(|| selection.permission_mode_wire.clone());
    let feature_id =
        persist_and_commit_switch(app_state, sdk_sessions, db_session_id, selection).await?;
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        &WsSessionEvent::ProviderSetOk(reply),
    )
    .await;
    if let Some(mode) = mode {
        super::reply_and_broadcast(
            app_state,
            sender,
            &envelope.id,
            feature_id,
            &WsSessionEvent::ModeChanged(ModeChangedPayload { mode }),
        )
        .await;
    }
    Ok(())
}

/// Database first, then the live handle. Restore every written column if a
/// prompt starts during persistence and the in-memory commit is rejected.
async fn persist_and_commit_switch(
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    db_session_id: i64,
    selection: SwitchSelection,
) -> Result<i64, ProviderSetError> {
    switch::ensure_still_pending(sdk_sessions, db_session_id).await?;
    let previous = read_persisted_selection(&app_state.read_pool, db_session_id)
        .await
        .map_err(|error| {
            error!(db_session_id, %error, "failed to read runtime selection");
            ProviderSetError::new("DB_ERROR", "Failed to read the current runtime selection")
        })?;
    persistence::persist(&app_state.write_pool, db_session_id, &selection)
        .await
        .map_err(|error| {
            error!(db_session_id, %error, "failed to persist runtime selection");
            ProviderSetError::new("DB_ERROR", "Failed to persist runtime provider selection")
        })?;
    match switch::commit_switch(sdk_sessions, db_session_id, selection).await {
        Ok(feature_id) => Ok(feature_id),
        Err(rejection) => {
            restore_persisted_selection(&app_state.write_pool, db_session_id, &previous).await?;
            Err(rejection)
        }
    }
}
