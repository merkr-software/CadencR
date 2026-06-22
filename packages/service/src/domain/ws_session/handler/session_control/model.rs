use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use super::effort::{apply_effort_change, send_effort_set_ok, EffortChangeError};
use super::session_has_messages;
use crate::app_state::AppState;
use crate::domain::agents::runtime::DEFAULT_PROVIDER;
use crate::domain::agents::{adapter_for_model, runtime_adapter};

fn provider_for_model(current_provider: &str, model: &str) -> String {
    adapter_for_model(model)
        .map(|(provider_id, _)| provider_id)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if current_provider != DEFAULT_PROVIDER && !model.contains('/') {
                return DEFAULT_PROVIDER.to_string();
            }

            current_provider.to_string()
        })
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

    let has_messages = match session_has_messages(&app_state.read_pool, db_session_id).await {
        Ok(value) => value,
        Err(error) => {
            error!(db_session_id, %error, "failed to verify session history before model change");
            send_error(
                sender,
                &envelope.id,
                "DB_ERROR",
                "Failed to verify session history",
            );
            return;
        }
    };

    // Reach the map that owns the live runtime, not just this viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;

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
    let feature_id = handle.feature_id;

    let target_provider = provider_for_model(&handle.runtime_provider, &payload.model);
    if has_messages && handle.runtime_provider != target_provider {
        send_error(
            sender,
            &envelope.id,
            "PROVIDER_LOCKED",
            "Start a new session to switch providers",
        );
        return;
    }

    let should_clear_effort = super::super::thinking_effort::should_clear_for_model(
        &target_provider,
        &payload.model,
        handle.desired_thinking_effort.as_deref(),
    );
    if let Err(error) =
        apply_model_to_handle(handle, db_session_id, &target_provider, &payload.model).await
    {
        error!(db_session_id, %error, "failed to set model on active query");
        send_error(sender, &envelope.id, "SDK_ERROR", &error);
        return;
    }

    let runtime_provider = handle.runtime_provider.clone();
    drop(sessions);

    let seeded_window = seed_context_window(&payload.model, &runtime_provider).await;
    persist_model_selection(
        app_state,
        db_session_id,
        &payload.model,
        &runtime_provider,
        seeded_window,
    )
    .await;

    if should_clear_effort
        && !clear_unsupported_effort(sdk_sessions, app_state, sender, &envelope.id, db_session_id)
            .await
    {
        return;
    }

    send_model_set_ok(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        payload.model,
        seeded_window,
    )
    .await;

    if should_clear_effort {
        send_effort_set_ok(app_state, sender, &envelope.id, feature_id, None).await;
    }
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

async fn clear_unsupported_effort(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
) -> bool {
    match apply_effort_change(sdk_sessions, app_state, db_session_id, None).await {
        Ok(_) => true,
        Err(EffortChangeError::SessionNotFound) => {
            send_error(
                sender,
                envelope_id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            false
        }
        Err(EffortChangeError::Sdk(error)) => {
            error!(db_session_id, %error, "failed to clear unsupported thinking effort");
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
    // answer authoritatively right now (e.g. opencode knows its catalog
    // windows). Never fall back to history — for Claude Code, the CLI is the
    // source of truth and the window arrives on the first `result` event.
    // Token counts are NOT reset: the conversation history has not changed,
    // only the model has. The first `result` from the new model will stamp
    // fresh token totals.
    let target_adapter = adapter_for_model(model)
        .map(|(_, a)| a)
        .or_else(|| runtime_adapter(runtime_provider));
    match target_adapter {
        Some(adapter) => adapter.context_window_for_model(model).await,
        None => None,
    }
}

async fn send_model_set_ok(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    model: String,
    seeded_window: Option<u64>,
) {
    // Reply to the caller and mirror to other devices so their model chip updates.
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        "model.set.ok",
        serde_json::json!({
            "model": model,
            "context_window": seeded_window,
        }),
    )
    .await;
}
