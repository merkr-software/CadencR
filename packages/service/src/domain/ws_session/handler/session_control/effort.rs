use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{parse_session_id, send_error};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;
use crate::domain::settings;
use crate::domain::settings_store;
use crate::error::AppError;

pub(super) enum EffortChangeError {
    SessionNotFound,
    Sdk(String),
}

/// Handle session.effort.set: change the thinking effort for subsequent turns.
pub(crate) async fn handle_effort_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let payload: EffortSetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return;
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
            return;
        }
    };

    let feature_id = match apply_effort_change(
        sdk_sessions,
        app_state,
        db_session_id,
        payload.thinking_effort.clone(),
    )
    .await
    {
        Ok(feature_id) => feature_id,
        Err(EffortChangeError::SessionNotFound) => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
        Err(EffortChangeError::Sdk(error)) => {
            error!(db_session_id, %error, "failed to set thinking effort on active query");
            send_error(sender, &envelope.id, "SDK_ERROR", &error);
            return;
        }
    };

    send_effort_set_ok(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        payload.thinking_effort,
    )
    .await;
}

/// What a session effort change resolved to, so the caller can decide what to
/// remember for the workspace.
struct AppliedEffort {
    feature_id: i64,
    runtime_provider: String,
    current_model: Option<String>,
}

/// Apply a user's explicit effort choice: the live session plus the workspace
/// default for the model it runs on. Resets (None) keep the stored default, so
/// clearing one conversation does not surprise the next.
pub(super) async fn apply_effort_change(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    thinking_effort: Option<String>,
) -> Result<i64, EffortChangeError> {
    let applied = apply_session_effort(
        sdk_sessions,
        app_state,
        db_session_id,
        thinking_effort.clone(),
    )
    .await?;
    if let (Some(effort), Some(model_id)) = (thinking_effort.as_deref(), &applied.current_model) {
        if let Err(error) =
            persist_model_thinking_default(app_state, &applied.runtime_provider, model_id, effort)
                .await
        {
            error!(
                db_session_id,
                %error,
                model = %model_id,
                "failed to persist per-model thinking effort default"
            );
        }
    }
    Ok(applied.feature_id)
}

/// Apply an effort to the session without touching the workspace default.
/// Model switches use this: they resume the target's level, which must not be
/// recorded as if the user had chosen it.
async fn apply_session_effort(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    thinking_effort: Option<String>,
) -> Result<AppliedEffort, EffortChangeError> {
    // Reach the map that owns the live runtime, not just this viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;

    // Snapshot the (provider, model) at the moment of the change so the per-
    // model workspace default is keyed against the model that's actually in
    // use right now. If the user later switches models, that's a separate
    // event and should not back-propagate to the previous model's default.
    let (active_query, runtime_provider, current_model, feature_id): (
        Option<RuntimeSessionHandle>,
        String,
        Option<String>,
        i64,
    ) = {
        let mut sessions = sdk_sessions.lock().await;
        let handle = match sessions.get_mut(&db_session_id) {
            Some(h) => h,
            None => return Err(EffortChangeError::SessionNotFound),
        };

        info!(
            db_session_id,
            thinking_effort = ?thinking_effort,
            "updating desired thinking effort"
        );
        handle.desired_thinking_effort = thinking_effort.clone();
        handle.config.thinking_effort = thinking_effort.clone();

        let provider = handle.runtime_provider.clone();
        let model = handle
            .desired_model
            .clone()
            .or_else(|| handle.spawned_model.clone());
        let feature_id = handle.feature_id;

        let active = match &mut handle.state {
            QueryState::Pending(options) => {
                options.thinking_effort = thinking_effort.clone();
                None
            }
            QueryState::Active { query, .. } => Some(query.clone()),
        };
        (active, provider, model, feature_id)
    };

    if let Some(query) = active_query {
        let q = query.read().await;
        let applies_in_place = q.applies_thinking_effort_in_place();
        q.set_thinking_effort(thinking_effort.clone())
            .await
            .map_err(|error| EffortChangeError::Sdk(error.to_string()))?;

        if applies_in_place {
            let mut sessions = sdk_sessions.lock().await;
            if let Some(handle) = sessions.get_mut(&db_session_id) {
                handle.spawned_thinking_effort = thinking_effort.clone();
            }
        }
    }

    // Persist the conversation-level override (column on agent_sessions). A
    // None payload clears the override; the next session.init will fall back
    // to the per-model workspace default.
    WsSessionPersistence::update_thinking_effort_static(
        &app_state.write_pool,
        db_session_id,
        thinking_effort.as_deref(),
    )
    .await;

    Ok(AppliedEffort {
        feature_id,
        runtime_provider,
        current_model,
    })
}

/// Apply the effort a model switch resumes (its last-used level, or `None`).
/// Errors are reported to the caller's socket and yield `false`.
pub(super) async fn apply_model_default_effort(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    thinking_effort: Option<String>,
) -> bool {
    match apply_session_effort(sdk_sessions, app_state, db_session_id, thinking_effort).await {
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
            error!(db_session_id, %error, "failed to apply the new model's thinking effort");
            send_error(sender, envelope_id, "SDK_ERROR", &error);
            false
        }
    }
}

/// Record `effort` as the user's last choice for one provider/model pair, so a
/// later model switch or MCP spawn on that pair resumes it.
pub(super) async fn persist_model_thinking_default(
    app_state: &AppState,
    provider: &str,
    model_id: &str,
    effort: &str,
) -> Result<(), AppError> {
    let key = settings::thinking_effort_model_key(provider, model_id);
    // A switch back to a model often re-sends the value already stored; skip
    // the rewrite and its settings-changed broadcast in that case.
    if settings_store::global_get(&key).as_deref() == Some(effort) {
        return Ok(());
    }
    crate::domain::workspace::repository::set_setting(&app_state.write_pool, &key, effort).await
}

pub(super) async fn send_effort_set_ok(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    thinking_effort: Option<String>,
) {
    // Reply to the caller and mirror to other devices so their effort chip updates.
    super::reply_and_broadcast(
        app_state,
        sender,
        envelope_id,
        feature_id,
        WsSessionAction::EffortSetOk,
        EffortSetOkPayload { thinking_effort },
    )
    .await;
}
