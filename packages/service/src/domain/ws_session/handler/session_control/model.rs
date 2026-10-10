use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::send_error;
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use super::effort::{apply_model_default_effort, send_effort_set_ok};
use super::fast_mode::send_fast_mode_set_ok;
use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeConfigOverrides;
use crate::domain::agents::runtime_adapter;
use crate::domain::settings::target_thinking_effort;

mod finalize;
mod validation;

use finalize::{
    clear_unsupported_fast_mode, persist_model_selection, seed_context_window, send_model_set_ok,
};
use validation::{parse_model_set_request, validate_model_set, ModelSetSnapshot};

/// What switching the handle's model changed, captured under the session lock.
struct ModelSwitch {
    feature_id: i64,
    runtime_provider: String,
    effort_changes: bool,
    should_clear_fast_mode: bool,
    /// The override document to persist, for providers that spawn from it.
    overrides: Option<RuntimeConfigOverrides>,
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
    // Switching models resumes the target's last-used level (or its default),
    // never the outgoing model's level.
    let target_effort =
        target_thinking_effort(&app_state.read_pool, &snapshot.runtime_provider, &entry).await;

    let switch = match switch_handle_model(
        sdk_sessions,
        db_session_id,
        &snapshot,
        &model,
        entry.supports_fast_mode == Some(true),
        target_effort.as_deref(),
    )
    .await
    {
        Ok(switch) => switch,
        Err((code, message)) => return send_error(sender, &envelope.id, code, &message),
    };
    let seeded_window = match persist_switch(app_state, db_session_id, &model, &switch).await {
        Ok(window) => window,
        Err(error) => return send_error(sender, &envelope.id, "DB_ERROR", &error),
    };

    let reconciled = reconcile_switched_controls(
        sdk_sessions,
        app_state,
        sender,
        &envelope.id,
        db_session_id,
        &switch,
        target_effort.clone(),
    )
    .await;
    if !reconciled {
        return;
    }

    send_model_set_ok(
        app_state,
        sender,
        &envelope.id,
        switch.feature_id,
        switch.runtime_provider,
        model,
        seeded_window,
    )
    .await;
    if switch.effort_changes {
        send_effort_set_ok(
            app_state,
            sender,
            &envelope.id,
            switch.feature_id,
            target_effort,
        )
        .await;
    }
    if switch.should_clear_fast_mode {
        send_fast_mode_set_ok(app_state, sender, &envelope.id, switch.feature_id, false).await;
    }
}

/// Persist the switch and return the context window seeded for the new model.
async fn persist_switch(
    app_state: &AppState,
    db_session_id: i64,
    model: &str,
    switch: &ModelSwitch,
) -> Result<Option<u64>, String> {
    if let Some(overrides) = switch.overrides.as_ref() {
        WsSessionPersistence::update_runtime_overrides_static(
            &app_state.write_pool,
            db_session_id,
            overrides,
        )
        .await
        .map_err(|error| error.to_string())?;
    }
    let seeded_window = seed_context_window(model, &switch.runtime_provider).await;
    persist_model_selection(
        app_state,
        db_session_id,
        model,
        &switch.runtime_provider,
        seeded_window,
    )
    .await;
    Ok(seeded_window)
}

/// Bring the effort and fast mode in line with the new model. Errors are
/// reported to the caller's socket and yield `false`.
async fn reconcile_switched_controls(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
    switch: &ModelSwitch,
    target_effort: Option<String>,
) -> bool {
    if switch.effort_changes
        && !apply_model_default_effort(
            sdk_sessions,
            app_state,
            sender,
            envelope_id,
            db_session_id,
            target_effort,
        )
        .await
    {
        return false;
    }
    !switch.should_clear_fast_mode
        || clear_unsupported_fast_mode(sdk_sessions, app_state, sender, envelope_id, db_session_id)
            .await
}

/// Point the live handle at `model` under one lock, after checking that the
/// provider and profile did not change while the model was being validated.
async fn switch_handle_model(
    sessions: &SdkSessions,
    db_session_id: i64,
    snapshot: &ModelSetSnapshot,
    model: &str,
    supports_fast_mode: bool,
    target_effort: Option<&str>,
) -> Result<ModelSwitch, (&'static str, String)> {
    let mut sessions = sessions.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return Err(("SESSION_NOT_FOUND", "Session not found".to_string()));
    };
    if handle.runtime_provider != snapshot.runtime_provider {
        return Err((
            "PROVIDER_CHANGED",
            "Provider changed while validating the model; retry the selection".to_string(),
        ));
    }
    if handle.desired_claude_profile != snapshot.claude_profile {
        return Err((
            "PROFILE_CHANGED",
            "Profile changed while validating the model; retry the selection".to_string(),
        ));
    }
    let effort_changes = handle.desired_thinking_effort.as_deref() != target_effort;
    let should_clear_fast_mode = handle.config.fast_mode && !supports_fast_mode;
    if let Err(error) =
        apply_model_to_handle(handle, db_session_id, &snapshot.runtime_provider, model).await
    {
        error!(db_session_id, %error, "failed to set model on active query");
        return Err(("SDK_ERROR", error));
    }
    let inherits_profile = runtime_adapter(&snapshot.runtime_provider)
        .is_some_and(|adapter| adapter.supports_profile_config_inheritance());
    let overrides = if inherits_profile {
        // Such a provider spawns from the override document, so it must carry
        // the re-derived level as well, not the outgoing model's.
        let target_effort = target_effort.map(ToOwned::to_owned);
        handle.config.overrides.model = Some(model.to_string());
        handle.config.overrides.thinking_effort = target_effort.clone();
        if let QueryState::Pending(options) = &mut handle.state {
            options.overrides.model = Some(model.to_string());
            options.overrides.thinking_effort = target_effort;
        }
        Some(handle.config.overrides.clone())
    } else {
        None
    };
    Ok(ModelSwitch {
        feature_id: handle.feature_id,
        runtime_provider: handle.runtime_provider.clone(),
        effort_changes,
        should_clear_fast_mode,
        overrides,
    })
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
