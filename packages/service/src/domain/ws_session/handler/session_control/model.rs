use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use super::effort::{apply_model_default_effort, send_effort_set_ok};
use super::fast_mode::{apply_fast_mode_change, send_fast_mode_set_ok, FastModeChangeError};
use crate::app_state::AppState;
use crate::domain::agents::providers::{
    canonical_provider_or_error, resolve_model_or_error_for_profile,
};
use crate::domain::agents::runtime::ModelCatalogEntry;
use crate::domain::agents::runtime_adapter;
use crate::domain::settings::target_thinking_effort;

struct ModelSetSnapshot {
    runtime_provider: String,
    cwd: std::path::PathBuf,
    claude_profile: Option<String>,
}

/// Handle session.model.set: change the model and persist to DB.
pub(crate) async fn handle_model_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some((payload, db_session_id)) = parse_model_set_request(&envelope, sender) else {
        return;
    };

    // Reach the map that owns the live runtime, not just this viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;

    let Some((snapshot, model, entry)) = validate_model_set(
        sdk_sessions,
        app_state,
        sender,
        &envelope.id,
        db_session_id,
        &payload,
    )
    .await
    else {
        return;
    };
    let supports_fast_mode = entry.supports_fast_mode == Some(true);
    // Switching models resumes the target's last-used level (or its default),
    // never the outgoing model's level.
    let target_effort =
        target_thinking_effort(&app_state.read_pool, &snapshot.runtime_provider, &entry).await;

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
    if handle.runtime_provider != snapshot.runtime_provider {
        send_error(
            sender,
            &envelope.id,
            "PROVIDER_CHANGED",
            "Provider changed while validating the model; retry the selection",
        );
        return;
    }
    if handle.desired_claude_profile != snapshot.claude_profile {
        send_error(
            sender,
            &envelope.id,
            "PROFILE_CHANGED",
            "Profile changed while validating the model; retry the selection",
        );
        return;
    }
    let feature_id = handle.feature_id;
    let effort_changes = handle.desired_thinking_effort.as_deref() != target_effort.as_deref();
    let should_clear_fast_mode = handle.config.fast_mode && !supports_fast_mode;
    if let Err(error) =
        apply_model_to_handle(handle, db_session_id, &snapshot.runtime_provider, &model).await
    {
        error!(db_session_id, %error, "failed to set model on active query");
        send_error(sender, &envelope.id, "SDK_ERROR", &error);
        return;
    }
    let overrides = if crate::domain::agents::providers::runtime_adapter(&snapshot.runtime_provider)
        .is_some_and(|adapter| adapter.supports_profile_config_inheritance())
    {
        handle.config.overrides.model = Some(model.clone());
        if let QueryState::Pending(options) = &mut handle.state {
            options.overrides.model = Some(model.clone());
        }
        Some(handle.config.overrides.clone())
    } else {
        None
    };

    let runtime_provider = handle.runtime_provider.clone();
    drop(sessions);
    if let Some(overrides) = overrides.as_ref() {
        if let Err(error) = WsSessionPersistence::update_runtime_overrides_static(
            &app_state.write_pool,
            db_session_id,
            overrides,
        )
        .await
        {
            send_error(sender, &envelope.id, "DB_ERROR", &error.to_string());
            return;
        }
    }

    let seeded_window = seed_context_window(&model, &runtime_provider).await;
    persist_model_selection(
        app_state,
        db_session_id,
        &model,
        &runtime_provider,
        seeded_window,
    )
    .await;

    if effort_changes
        && !apply_model_default_effort(
            sdk_sessions,
            app_state,
            sender,
            &envelope.id,
            db_session_id,
            target_effort.clone(),
        )
        .await
    {
        return;
    }

    if should_clear_fast_mode
        && !clear_unsupported_fast_mode(
            sdk_sessions,
            app_state,
            sender,
            &envelope.id,
            db_session_id,
        )
        .await
    {
        return;
    }

    send_model_set_ok(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        runtime_provider,
        model,
        seeded_window,
    )
    .await;

    if effort_changes {
        send_effort_set_ok(app_state, sender, &envelope.id, feature_id, target_effort).await;
    }
    if should_clear_fast_mode {
        send_fast_mode_set_ok(app_state, sender, &envelope.id, feature_id, false).await;
    }
}

async fn validate_model_set(
    sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    payload: &ModelSetPayload,
) -> Option<(ModelSetSnapshot, String, ModelCatalogEntry)> {
    let snapshot = {
        let sessions = sessions.lock().await;
        let Some(handle) = sessions.get(&db_session_id) else {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return None;
        };
        ModelSetSnapshot {
            runtime_provider: handle.runtime_provider.clone(),
            cwd: handle.config.cwd.clone(),
            claude_profile: handle.desired_claude_profile.clone(),
        }
    };
    if !validate_requested_provider(payload, &snapshot.runtime_provider, sender, envelope_id) {
        return None;
    }
    match resolve_model_or_error_for_profile(
        &app_state.read_pool,
        Some(&snapshot.cwd),
        &snapshot.runtime_provider,
        &payload.model,
        snapshot.claude_profile.as_deref(),
    )
    .await
    {
        Ok((model, entry)) => Some((snapshot, model, entry)),
        Err(error) => {
            send_error(
                sender,
                envelope_id,
                "MODEL_PROVIDER_MISMATCH",
                &error.to_string(),
            );
            None
        }
    }
}

fn validate_requested_provider(
    payload: &ModelSetPayload,
    runtime_provider: &str,
    sender: &WsSender,
    envelope_id: &str,
) -> bool {
    let Some(requested_provider) = payload.provider.as_deref() else {
        return true;
    };
    let requested_provider = match canonical_provider_or_error(requested_provider) {
        Ok(provider) => provider,
        Err(error) => {
            send_error(sender, envelope_id, "INVALID_PROVIDER", &error.to_string());
            return false;
        }
    };
    if requested_provider == runtime_provider {
        return true;
    }
    send_error(
        sender,
        envelope_id,
        "PROVIDER_MISMATCH",
        "Selected model provider does not match the active session provider",
    );
    false
}

fn parse_model_set_request(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<(ModelSetPayload, i64)> {
    let payload: ModelSetPayload = match serde_json::from_value(envelope.payload.clone()) {
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

async fn clear_unsupported_fast_mode(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
) -> bool {
    match apply_fast_mode_change(sdk_sessions, app_state, db_session_id, false).await {
        Ok(_) => true,
        Err(FastModeChangeError::SessionNotFound) => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            false
        }
        Err(FastModeChangeError::Unsupported) => true,
        Err(FastModeChangeError::ConfigurationChanged) => {
            send_error(
                sender,
                envelope_id,
                "SESSION_CONFIG_CHANGED",
                "Session configuration changed while clearing fast mode; retry the selection",
            );
            false
        }
        Err(FastModeChangeError::Persistence(error)) => {
            error!(db_session_id, %error, "failed to persist cleared fast mode");
            send_error(
                sender,
                envelope_id,
                "DB_ERROR",
                "Failed to persist cleared fast mode",
            );
            false
        }
        Err(FastModeChangeError::Sdk(error)) => {
            error!(db_session_id, %error, "failed to clear unsupported fast mode");
            send_error(sender, envelope_id, "SDK_ERROR", &error);
            false
        }
    }
}

async fn apply_model_to_handle(
    handle: &mut SdkHandle,
    db_session_id: i64,
    target_provider: &str,
    model: &str,
) -> Result<(), String> {
    info!(db_session_id, model = %model, "updating desired model");
    handle.desired_model = Some(model.to_string());

    match &mut handle.state {
        QueryState::Pending(options) => {
            options.model = Some(model.to_string());
            if handle.runtime_provider.as_str() != target_provider {
                handle.runtime_provider = target_provider.to_string();
                handle.resume_session_id = None;
                options.resume_session_id = None;
            }
        }
        QueryState::Active { query, .. } => {
            let q = query.read().await;
            q.set_model(model)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn persist_model_selection(
    app_state: &AppState,
    db_session_id: i64,
    model: &str,
    runtime_provider: &str,
    context_window: Option<u64>,
) {
    WsSessionPersistence::update_model_static(&app_state.write_pool, db_session_id, model).await;
    if let Err(error) = sqlx::query("UPDATE agent_sessions SET runtime_provider = ? WHERE id = ?")
        .bind(runtime_provider)
        .bind(db_session_id)
        .execute(&app_state.write_pool)
        .await
    {
        error!(%error, session_db_id = db_session_id, "failed to persist runtime provider");
    }
    WsSessionPersistence::update_context_window(
        &app_state.write_pool,
        db_session_id,
        context_window,
    )
    .await;
}

async fn seed_context_window(model: &str, runtime_provider: &str) -> Option<u64> {
    // Seed the new model's context window ONLY when the target adapter can
    // answer authoritatively right now — opencode from its catalog, Claude
    // Code from what a previous turn's `result` reported for that exact model
    // id. `None` clears the stored window rather than leaving the outgoing
    // model's, which would misscale the bar until the next `result`.
    // Token counts are NOT reset: the conversation history has not changed,
    // only the model has. The first `result` from the new model will stamp
    // fresh token totals.
    match runtime_adapter(runtime_provider) {
        Some(adapter) => adapter.context_window_for_model(model).await,
        None => None,
    }
}

async fn send_model_set_ok(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    provider: String,
    model: String,
    seeded_window: Option<u64>,
) {
    // Reply to the caller and mirror to other devices so their model chip updates.
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        WsSessionAction::ModelSetOk,
        ModelSetOkPayload {
            provider,
            model,
            context_window: seeded_window,
        },
    )
    .await;
}
