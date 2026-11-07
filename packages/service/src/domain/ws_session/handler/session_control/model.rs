use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::send_error;
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use super::effort::{apply_model_default_effort, send_effort_set_ok};
use super::fast_mode::send_fast_mode_set_ok;
use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimeConfigOverrides, RuntimeSessionHandle};
use crate::domain::agents::runtime_adapter;
use crate::domain::settings::target_thinking_effort;
use crate::domain::ws_session::runtime::detached_runtime::{was_replaced, LIVE_SWITCH_ATTEMPTS};

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
    // Two devices switching at once must not leave the cell and the database
    // on one value while the runtime runs the other.
    let _control = app_state
        .session_runtimes
        .claim_control(db_session_id)
        .await;

    // Reach the map that owns the live runtime, not just this viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, &app_state.active_turns, db_session_id).await;
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
    // The row first, before the catalog lookup below: prompts dispatched by
    // other connections adopt the row, so it must not lag behind the handle.
    let pool = &app_state.write_pool;
    match switch.overrides.as_ref() {
        Some(overrides) => {
            WsSessionPersistence::update_runtime_overrides_and_model(
                pool,
                db_session_id,
                overrides,
                Some(model),
            )
            .await
        }
        None => WsSessionPersistence::update_model_static(pool, db_session_id, model).await,
    }
    .map_err(|error| error.to_string())?;
    let seeded_window = seed_context_window(model, &switch.runtime_provider).await;
    persist_model_selection(
        app_state,
        db_session_id,
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

/// Point the handle at `model`, after checking that the provider and profile
/// did not change while the model was being validated. A live runtime switches
/// with the session lock released (see `detached_runtime`), and the handle
/// takes the switch only while it still runs that runtime.
async fn switch_handle_model(
    sessions: &SdkSessions,
    db_session_id: i64,
    snapshot: &ModelSetSnapshot,
    model: &str,
    supports_fast_mode: bool,
    target_effort: Option<&str>,
) -> Result<ModelSwitch, (&'static str, String)> {
    for _ in 0..LIVE_SWITCH_ATTEMPTS {
        let (target, previous) = {
            let sessions = sessions.lock().await;
            let handle = sessions.get(&db_session_id).ok_or_else(session_not_found)?;
            check_unchanged(handle, snapshot)?;
            let previous = handle
                .desired_model
                .clone()
                .or(handle.spawned_model.clone());
            (handle.state.active_query(), previous)
        };
        if let Some(query) = target.as_ref() {
            info!(db_session_id, model = %model, "switching the live runtime's model");
            if let Err(error) = query.read().await.set_model(model).await {
                if was_replaced(sessions, db_session_id, query).await {
                    continue;
                }
                error!(db_session_id, %error, "failed to set model on active query");
                return Err(("SDK_ERROR", error.to_string()));
            }
        }
        let mut guard = sessions.lock().await;
        let checked = guard
            .get_mut(&db_session_id)
            .ok_or_else(session_not_found)
            .and_then(|handle| check_unchanged(handle, snapshot).map(|()| handle));
        let handle = match checked {
            Ok(handle) => handle,
            Err(failure) => {
                drop(guard);
                return Err(roll_back_model(target.as_ref(), previous.as_deref(), failure).await);
            }
        };
        if handle.state.runs(target.as_ref()) {
            return Ok(commit_model_switch(
                handle,
                snapshot,
                model,
                supports_fast_mode,
                target_effort,
            ));
        }
    }
    Err((
        "SESSION_CONFIG_CHANGED",
        "The session's runtime restarted while switching models; retry the selection".to_string(),
    ))
}

/// Put the runtime back on `previous` after the switch was refused.
async fn roll_back_model(
    target: Option<&RuntimeSessionHandle>,
    previous: Option<&str>,
    failure: (&'static str, String),
) -> (&'static str, String) {
    let (Some(query), Some(previous)) = (target, previous) else {
        return failure;
    };
    match query.read().await.set_model(previous).await {
        Ok(()) => failure,
        Err(error) => (
            failure.0,
            format!(
                "{}; restoring the previous model failed: {error}",
                failure.1
            ),
        ),
    }
}

fn session_not_found() -> (&'static str, String) {
    ("SESSION_NOT_FOUND", "Session not found".to_string())
}

fn check_unchanged(
    handle: &SdkHandle,
    snapshot: &ModelSetSnapshot,
) -> Result<(), (&'static str, String)> {
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
    Ok(())
}

/// Record the switch the runtime (if any) already accepted.
fn commit_model_switch(
    handle: &mut SdkHandle,
    snapshot: &ModelSetSnapshot,
    model: &str,
    supports_fast_mode: bool,
    target_effort: Option<&str>,
) -> ModelSwitch {
    let effort_changes = handle.desired_thinking_effort.as_deref() != target_effort;
    let should_clear_fast_mode = handle.config.fast_mode && !supports_fast_mode;
    handle.desired_model = Some(model.to_string());
    if let QueryState::Pending(options) = &mut handle.state {
        options.model = Some(model.to_string());
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
    ModelSwitch {
        feature_id: handle.feature_id,
        runtime_provider: handle.runtime_provider.clone(),
        effort_changes,
        should_clear_fast_mode,
        overrides,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::cell_lock_probe::{
        assert_unlocked, probe_handle,
    };
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    fn snapshot_of(handle: &SdkHandle) -> ModelSetSnapshot {
        ModelSetSnapshot {
            runtime_provider: handle.runtime_provider.clone(),
            cwd: handle.config.cwd.clone(),
            claude_profile: handle.desired_claude_profile.clone(),
        }
    }

    #[tokio::test]
    async fn the_live_model_switches_with_the_session_lock_released() {
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle(&sessions, 7);
        let snapshot = snapshot_of(&handle);
        sessions.lock().await.insert(41, handle);

        let switch = switch_handle_model(&sessions, 41, &snapshot, "opus", false, None)
            .await
            .unwrap_or_else(|(code, message)| panic!("{code}: {message}"));

        assert_unlocked(&calls, 1);
        assert_eq!(switch.feature_id, 7);
        let sessions = sessions.lock().await;
        assert_eq!(sessions[&41].desired_model.as_deref(), Some("opus"));
    }

    #[tokio::test]
    async fn a_runtime_replaced_mid_switch_spawns_on_the_new_model() {
        use crate::domain::ws_session::handler::tests::cell_lock_probe::{
            probe_handle_changing, respawned_to_pending,
        };
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle_changing(&sessions, 7, Some(respawned_to_pending));
        let snapshot = snapshot_of(&handle);
        sessions.lock().await.insert(43, handle);

        switch_handle_model(&sessions, 43, &snapshot, "opus", false, None)
            .await
            .unwrap_or_else(|(code, message)| panic!("{code}: {message}"));

        assert_unlocked(&calls, 1);
        let sessions = sessions.lock().await;
        let QueryState::Pending(options) = &sessions[&43].state else {
            panic!("the respawn left the handle pending");
        };
        assert_eq!(options.model.as_deref(), Some("opus"));
    }

    #[tokio::test]
    async fn a_refused_switch_restores_the_runtime_model() {
        use crate::domain::ws_session::handler::tests::cell_lock_probe::probe_handle_changing;
        fn profile_changed(handle: &mut SdkHandle) {
            handle.desired_claude_profile = Some("work".to_string());
        }
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle_changing(&sessions, 7, Some(profile_changed));
        let snapshot = snapshot_of(&handle);
        sessions.lock().await.insert(44, handle);

        let Err((code, _)) =
            switch_handle_model(&sessions, 44, &snapshot, "opus", false, None).await
        else {
            panic!("a profile change must refuse the switch");
        };

        assert_eq!(code, "PROFILE_CHANGED");
        assert_unlocked(&calls, 2);
        assert_eq!(
            sessions.lock().await[&44].desired_model.as_deref(),
            Some("sonnet")
        );
    }

    #[tokio::test]
    async fn a_provider_change_during_validation_is_rejected() {
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle(&sessions, 7);
        let mut snapshot = snapshot_of(&handle);
        snapshot.runtime_provider = "codex".to_string();
        sessions.lock().await.insert(42, handle);

        let Err((code, _)) =
            switch_handle_model(&sessions, 42, &snapshot, "opus", false, None).await
        else {
            panic!("the switch must not apply to another provider");
        };

        assert_eq!(code, "PROVIDER_CHANGED");
        assert_unlocked(&calls, 0);
    }
}
