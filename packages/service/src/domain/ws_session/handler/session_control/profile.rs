use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::session_profile::{
    apply_profile_update, desired_profile_name, resolve_provider_profile,
};
use super::super::types::{SdkSessions, WsSender};
use crate::app_state::AppState;

pub(crate) async fn handle_profile_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some((payload, db_session_id)) = parse_profile_set_request(&envelope, sender) else {
        return;
    };
    let profile = payload.profile.trim();
    if profile.is_empty() {
        send_error(
            sender,
            &envelope.id,
            "INVALID_PROFILE",
            "Profile is required",
        );
        return;
    }

    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;
    let (feature_id, provider, model, current_profile) = {
        let sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        };
        (
            handle.feature_id,
            handle.runtime_provider.clone(),
            handle.desired_model.clone(),
            desired_profile_name(handle).map(str::to_string),
        )
    };

    let update = match resolve_provider_profile(app_state, &provider, profile).await {
        Ok(update) => update,
        Err(error) => {
            send_error(sender, &envelope.id, "PROFILE_ERROR", &error);
            return;
        }
    };
    let changed = {
        let mut sessions = sdk_sessions.lock().await;
        let Some(handle) = sessions.get_mut(&db_session_id) else {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        };
        apply_profile_update(handle, &update)
    };

    if changed || current_profile.as_deref() != Some(update.name.as_str()) {
        WsSessionPersistence::update_profile_static(
            &app_state.write_pool,
            db_session_id,
            &update.name,
        )
        .await;
    }
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        "profile.changed",
        serde_json::json!({
            "provider": provider,
            "model": model,
            "profile": update.name,
        }),
    )
    .await;
}

fn parse_profile_set_request(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<(ProfileSetPayload, i64)> {
    let payload: ProfileSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            return None;
        }
    };
    let db_session_id = match parse_session_id(&payload.session_id) {
        Some(id) => id,
        None => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_SESSION_ID",
                "Invalid session_id",
            );
            return None;
        }
    };
    Some((payload, db_session_id))
}
