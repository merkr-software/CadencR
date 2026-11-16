use axum::extract::ws::Message;
use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{
    parse_permission_mode, parse_session_id, provider_supports_mode, send_error,
    send_state_not_saved,
};
use super::super::types::{QueryState, SdkHandle, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionMode, RuntimeSessionHandle, RuntimeSpawnConfig,
};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::runtime::detached_runtime::{
    resume_session_id, was_replaced, DetachedRuntime, LIVE_SWITCH_ATTEMPTS,
};
use crate::domain::ws_session::runtime::prompt::respawn_deferral::{
    notify_change_deferred, respawn_deferral, RespawnDeferral,
};
use crate::domain::ws_session::runtime::SessionRuntimeRegistry;

/// Handle session.mode.set: change the permission mode and persist to DB.
pub(crate) async fn handle_mode_set(
    envelope: WsEnvelope,
    sender: &WsSender,
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
) {
    let Some(payload) = parse_mode_set_payload(&envelope, sender) else {
        return;
    };
    let Some(db_session_id) = parse_mode_set_session_id(&payload, &envelope.id, sender) else {
        return;
    };

    let new_mode = parse_permission_mode(&payload.mode);
    // Two devices switching at once must not leave the cell and the database
    // on one value while the runtime runs the other.
    let _control = app_state
        .session_runtimes
        .claim_control(db_session_id)
        .await;

    // The live turn may be owned by another connection (e.g. the host changing
    // the mode of a conversation started on a remote device). Operate on the
    // owning map so the change reaches the running CLI, not just our viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, &app_state.active_turns, db_session_id).await;

    let (feature_id, applied) = match apply_mode(
        &effective_sessions,
        app_state,
        db_session_id,
        &payload.mode,
        new_mode,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(payload) => {
            send_mode_set_error(sender, &envelope.id, payload);
            return;
        }
    };

    if let Err(error) = WsSessionPersistence::update_permission_mode_static(
        &app_state.write_pool,
        db_session_id,
        &payload.mode,
    )
    .await
    {
        send_state_not_saved(sender, &envelope.id, "the permission mode", &error);
    }

    // Reply to the caller and mirror to other devices so their mode chip updates.
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        &WsSessionEvent::ModeChanged(ModeChangedPayload { mode: payload.mode }),
    )
    .await;
    if let ModeApplied::Deferred(reason) = applied {
        notify_change_deferred(sender, &envelope.id, &["permission mode"], reason);
    }
}

/// How an active session took a permission-mode change.
enum ModeApplied {
    /// The live runtime switched (or was re-armed for the next prompt).
    Live,
    /// Enabling it needs a respawn, which would cut off work the runtime
    /// still owes the agent; the next free prompt applies it.
    Deferred(RespawnDeferral),
}

/// What the session lock decided; provider work runs after it is released.
enum ModeStep {
    Done(ModeApplied),
    /// Switch this live runtime, then record the mode it accepted.
    SetLive(RuntimeSessionHandle),
    /// The handle was re-armed; close the runtime it replaced.
    Close(DetachedRuntime),
}

/// Apply the mode with no provider call under the session lock (see
/// `detached_runtime`). A runtime replaced while it switched is planned again,
/// so the replacement (or its pending spawn) gets the mode too. Returns the
/// feature to broadcast to.
async fn apply_mode(
    sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    wire_mode: &str,
    new_mode: RuntimePermissionMode,
) -> Result<(i64, ModeApplied), SessionErrorPayload> {
    for _ in 0..LIVE_SWITCH_ATTEMPTS {
        let (feature_id, step) =
            plan_under_lock(sessions, app_state, db_session_id, wire_mode, &new_mode).await?;
        let query = match step {
            ModeStep::Done(applied) => return Ok((feature_id, applied)),
            ModeStep::Close(retired) => {
                retired.close_in(app_state).await;
                return Ok((feature_id, ModeApplied::Live));
            }
            ModeStep::SetLive(query) => query,
        };
        if let Err(error) = query
            .read()
            .await
            .set_permission_mode(new_mode.clone())
            .await
        {
            if was_replaced(sessions, db_session_id, &query).await {
                continue;
            }
            return Err(mode_set_error_payload(db_session_id, &new_mode, error));
        }
        let mut sessions = sessions.lock().await;
        match sessions.get_mut(&db_session_id) {
            Some(handle) if handle.state.runs(Some(&query)) => {
                record_mode(handle, new_mode, true);
                return Ok((feature_id, ModeApplied::Live));
            }
            Some(_) => {}
            None => return Ok((feature_id, ModeApplied::Live)),
        }
    }
    Err(error_payload(
        "SESSION_CONFIG_CHANGED",
        "The session's runtime restarted while switching the permission mode; retry the change"
            .to_string(),
    ))
}

async fn plan_under_lock(
    sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
    wire_mode: &str,
    new_mode: &RuntimePermissionMode,
) -> Result<(i64, ModeStep), SessionErrorPayload> {
    let mut sessions = sessions.lock().await;
    let handle = sessions
        .get_mut(&db_session_id)
        .ok_or_else(|| error_payload("SESSION_NOT_FOUND", "Session not found".to_string()))?;
    // Reject modes the active provider doesn't support — guards against a
    // stale FE catalog (e.g. user just switched provider but UI hadn't
    // re-rendered) and surfaces the failure to the user via the standard
    // error envelope rather than silently dropping the request.
    if !provider_supports_mode(&handle.runtime_provider, new_mode) {
        return Err(error_payload(
            "MODE_NOT_SUPPORTED",
            format!(
                "Provider {} does not support permission mode {wire_mode}",
                handle.runtime_provider
            ),
        ));
    }
    info!(db_session_id, mode = %wire_mode, "updating permission mode");
    let step = plan_mode_change(handle, db_session_id, new_mode.clone(), app_state).await;
    Ok((handle.feature_id, step))
}

async fn plan_mode_change(
    handle: &mut SdkHandle,
    db_session_id: i64,
    new_mode: RuntimePermissionMode,
    app_state: &AppState,
) -> ModeStep {
    let Some(query) = handle.state.active_query() else {
        queue_pending_permission_mode(handle, new_mode);
        return ModeStep::Done(ModeApplied::Live);
    };
    if !should_rearm_bypass(handle, &new_mode, &app_state.read_pool).await {
        return ModeStep::SetLive(query);
    }
    if let Some(reason) = respawn_deferral(app_state, db_session_id, &query) {
        // Re-arming closes the runtime, cutting off its turn or background
        // tasks. Record the mode; the prompt-time respawn arms bypass once the
        // runtime is free (`arm_bypass_for_respawn`).
        info!(
            db_session_id,
            ?reason,
            "runtime is busy; deferring bypass re-arm"
        );
        record_mode(handle, new_mode, false);
        return ModeStep::Done(ModeApplied::Deferred(reason));
    }
    rearm_claude_bypass_session(
        handle,
        query,
        db_session_id,
        new_mode,
        &app_state.session_runtimes,
    )
    .await
}

fn parse_mode_set_payload(envelope: &WsEnvelope, sender: &WsSender) -> Option<ModeSetPayload> {
    match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => Some(payload),
        Err(error) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &error.to_string());
            None
        }
    }
}

fn parse_mode_set_session_id(
    payload: &ModeSetPayload,
    ref_id: &str,
    sender: &WsSender,
) -> Option<i64> {
    match parse_session_id(&payload.session_id) {
        Some(id) => Some(id),
        None => {
            send_error(sender, ref_id, "INVALID_SESSION_ID", "Invalid session_id");
            None
        }
    }
}

fn queue_pending_permission_mode(handle: &mut SdkHandle, new_mode: RuntimePermissionMode) {
    // No live CLI yet; the queued mode will be passed via
    // `Options.permission_mode` at spawn time.
    handle.desired_permission_mode = Some(new_mode.clone());
    handle.config.permission_mode = Some(new_mode.clone());
    if let QueryState::Pending(options) = &mut handle.state {
        options.permission_mode = Some(new_mode);
    }
}

/// Record the mode the user wants; `accepted_by_spawned` when the runtime the
/// handle runs accepted it live. A runtime respawned meanwhile did not, so the
/// next prompt's respawn check still sees the difference.
fn record_mode(handle: &mut SdkHandle, new_mode: RuntimePermissionMode, accepted_by_spawned: bool) {
    handle.desired_permission_mode = Some(new_mode.clone());
    handle.config.permission_mode = Some(new_mode.clone());
    if accepted_by_spawned {
        // Track what the CLI actually accepted. Without this,
        // `plan_post_plan_mode_transition`'s "already in target mode"
        // short-circuit (post_plan_mode.rs) reads stale state and
        // may skip the post-plan-approval transition.
        handle.spawned_permission_mode = Some(new_mode);
    }
}

pub(in crate::domain::ws_session::handler) use crate::domain::ws_session::runtime::control_policy::should_rearm_bypass;

/// Point the handle at a bypass-armed respawn; the caller closes the runtime
/// it replaced once the session lock is released.
async fn rearm_claude_bypass_session(
    handle: &mut SdkHandle,
    query: RuntimeSessionHandle,
    db_session_id: i64,
    new_mode: RuntimePermissionMode,
    runtimes: &SessionRuntimeRegistry,
) -> ModeStep {
    let runtime_session_id = resume_session_id(&query, &handle.runtime_provider).await;
    handle.config.allow_bypass_permissions = true;
    handle.desired_permission_mode = Some(new_mode.clone());
    handle.config.permission_mode = Some(new_mode.clone());
    handle.state = QueryState::Pending(RuntimeSpawnConfig {
        cwd: handle.config.cwd.clone(),
        permission_mode: Some(new_mode.clone()),
        access_mode: handle.desired_access_mode.clone(),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        system_prompt: handle.config.system_prompt.clone(),
        resume_session_id: runtime_session_id,
        allow_bypass_permissions: true,
        env: handle.config.env.clone(),
        env_unset: handle.config.env_unset.clone(),
        profile: handle.config.claude_profile.clone(),
        overrides: handle.config.overrides.clone(),
        profile_revision: handle.config.profile_revision.clone(),
        profile_state_identity: handle.config.profile_state_identity.clone(),
        ..RuntimeSpawnConfig::default()
    });
    ModeStep::Close(DetachedRuntime::of(handle, query, db_session_id, runtimes))
}

fn error_payload(code: &str, message: String) -> SessionErrorPayload {
    SessionErrorPayload {
        code: code.into(),
        message,
        ..Default::default()
    }
}

fn mode_set_error_payload(
    db_session_id: i64,
    new_mode: &RuntimePermissionMode,
    error: RuntimeError,
) -> SessionErrorPayload {
    // Do not mutate desired/config state until the CLI accepts; otherwise the
    // next prompt could respawn invisibly into a mode the live CLI rejected.
    error!(db_session_id, error = %error, "failed to set permission mode on active query");
    match &error {
        RuntimeError::ControlRequestRejected { subtype, .. }
            if subtype == "set_permission_mode" =>
        {
            SessionErrorPayload {
                code: "MODE_REJECTED_BY_CLI".into(),
                message: error.to_string(),
                mode: Some(permission_mode_wire(new_mode)),
                ..Default::default()
            }
        }
        _ => SessionErrorPayload {
            code: "SDK_ERROR".into(),
            message: error.to_string(),
            ..Default::default()
        },
    }
}

fn send_mode_set_error(sender: &WsSender, ref_id: &str, payload: SessionErrorPayload) {
    let err = WsEnvelope::session_reply(ref_id, &WsSessionEvent::Error(payload))
        .expect("session event payload should serialize");
    let _ = sender.send(Message::Text(String::from(err).into()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::cell_lock_probe::{
        assert_unlocked, probe_handle,
    };
    use crate::domain::ws_session::handler::tests::support::make_test_app_state;
    use crate::domain::ws_session::handler::types::new_sdk_sessions;

    #[tokio::test]
    async fn the_live_mode_switches_with_the_session_lock_released() {
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle(&sessions, 7);
        sessions.lock().await.insert(51, handle);

        let (feature_id, applied) = apply_mode(
            &sessions,
            &app_state,
            51,
            "acceptEdits",
            RuntimePermissionMode::AcceptEdits,
        )
        .await
        .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));

        assert_unlocked(&calls, 1);
        assert_eq!(feature_id, 7);
        assert!(matches!(applied, ModeApplied::Live));
        let sessions = sessions.lock().await;
        assert_eq!(
            sessions[&51].spawned_permission_mode,
            Some(RuntimePermissionMode::AcceptEdits)
        );
    }

    #[tokio::test]
    async fn a_runtime_replaced_mid_switch_spawns_in_the_new_mode() {
        use crate::domain::ws_session::handler::tests::cell_lock_probe::{
            probe_handle_changing, respawned_to_pending,
        };
        let app_state = make_test_app_state().await;
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle_changing(&sessions, 7, Some(respawned_to_pending));
        sessions.lock().await.insert(54, handle);

        apply_mode(
            &sessions,
            &app_state,
            54,
            "acceptEdits",
            RuntimePermissionMode::AcceptEdits,
        )
        .await
        .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));

        assert_unlocked(&calls, 1);
        let sessions = sessions.lock().await;
        let QueryState::Pending(options) = &sessions[&54].state else {
            panic!("the respawn left the handle pending");
        };
        assert_eq!(
            options.permission_mode,
            Some(RuntimePermissionMode::AcceptEdits),
            "the next spawn must use the mode the user picked"
        );
    }

    async fn bypass_enabled_app_state() -> AppState {
        let app_state = make_test_app_state().await;
        crate::domain::workspace::repository::set_setting(
            &app_state.write_pool,
            "claude_bypass_permissions_enabled",
            "true",
        )
        .await
        .unwrap();
        app_state
    }

    #[tokio::test]
    async fn a_bypass_rearm_closes_the_idle_runtime_after_the_lock() {
        let app_state = bypass_enabled_app_state().await;
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle(&sessions, 7);
        sessions.lock().await.insert(53, handle);

        let (_, applied) = apply_mode(
            &sessions,
            &app_state,
            53,
            "bypassPermissions",
            RuntimePermissionMode::BypassPermissions,
        )
        .await
        .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));

        assert!(matches!(applied, ModeApplied::Live));
        assert_unlocked(&calls, 1);
        let sessions = sessions.lock().await;
        let QueryState::Pending(options) = &sessions[&53].state else {
            panic!("the handle respawns into bypass");
        };
        assert!(options.allow_bypass_permissions);
        assert_eq!(
            options.resume_session_id.as_deref(),
            Some("22222222-2222-4222-8222-222222222222")
        );
    }

    #[tokio::test]
    async fn a_bypass_rearm_waits_for_the_running_turn() {
        let app_state = bypass_enabled_app_state().await;
        app_state.session_status_tx.broadcast_running(52, 7);
        let sessions = new_sdk_sessions();
        let (handle, calls) = probe_handle(&sessions, 7);
        sessions.lock().await.insert(52, handle);

        let (_, applied) = apply_mode(
            &sessions,
            &app_state,
            52,
            "bypassPermissions",
            RuntimePermissionMode::BypassPermissions,
        )
        .await
        .unwrap_or_else(|error| panic!("{}: {}", error.code, error.message));

        assert!(matches!(
            applied,
            ModeApplied::Deferred(RespawnDeferral::LiveTurn)
        ));
        assert_unlocked(&calls, 0);
        let sessions = sessions.lock().await;
        assert!(matches!(sessions[&52].state, QueryState::Active { .. }));
        assert_eq!(
            sessions[&52].desired_permission_mode,
            Some(RuntimePermissionMode::BypassPermissions)
        );
    }
}
