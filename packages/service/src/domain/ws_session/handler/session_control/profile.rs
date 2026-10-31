use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::session_profile::{
    apply_profile_update, desired_profile_name, resolve_provider_profile,
    validate_resume_profile_state,
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
        super::resolve_owner_sessions(sdk_sessions, &app_state.active_turns, db_session_id).await;
    let sdk_sessions = &effective_sessions;
    let (feature_id, provider, model, current_profile, cwd, overrides) = {
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
            handle.config.cwd.clone(),
            handle.config.overrides.clone(),
        )
    };

    let update = match resolve_provider_profile(&provider, profile, &cwd).await {
        Ok(update) => update,
        Err(error) => {
            send_error(sender, &envelope.id, "PROFILE_ERROR", &error);
            return;
        }
    };
    let effective = match crate::domain::agents::providers::runtime_adapter(&provider) {
        Some(adapter) if adapter.supports_profile_config_inheritance() => match adapter
            .resolve_profile_effective_config(Some(&update.name), &cwd, &overrides)
            .await
        {
            Ok(effective) => Some(effective),
            Err(error) => {
                send_error(
                    sender,
                    &envelope.id,
                    "PROFILE_CONFIG_ERROR",
                    &error.to_string(),
                );
                return;
            }
        },
        Some(_) | None => None,
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
        if let Err(error) = validate_resume_profile_state(handle, &update) {
            send_error(sender, &envelope.id, "PROFILE_STATE_MISMATCH", &error);
            return;
        }
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
        &WsSessionEvent::ProfileChanged(ProfileChangedPayload {
            provider,
            model: effective
                .as_ref()
                .and_then(|config| config.model.clone())
                .or(model),
            profile: update.name,
            effective,
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
