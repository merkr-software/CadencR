use axum::extract::ws::Message;
use tracing::{error, info};

use super::super::super::persistence::WsSessionPersistence;
use super::super::super::protocol::*;
use super::super::helpers::{
    parse_permission_mode, parse_session_id, persist_and_close_query, provider_supports_mode,
    send_error,
};
use super::super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionMode, RuntimeSessionHandle, RuntimeSpawnConfig,
};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::ws_session::handler::session_prompt::runtime_hold_registry::{
    notify_change_deferred, runtime_is_held,
};

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

    // The live turn may be owned by another connection (e.g. the host changing
    // the mode of a conversation started on a remote device). Operate on the
    // owning map so the change reaches the running CLI, not just our viewer.
    let effective_sessions =
        super::resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let sdk_sessions = &effective_sessions;

    let mut sessions = sdk_sessions.lock().await;
    let handle = match sessions.get_mut(&db_session_id) {
        Some(h) => h,
        None => {
            send_error(
                sender,
                &envelope.id,
                "SESSION_NOT_FOUND",
                "Session not found",
            );
            return;
        }
    };
    let feature_id = handle.feature_id;

    // Reject modes the active provider doesn't support — guards against a
    // stale FE catalog (e.g. user just switched provider but UI hadn't
    // re-rendered) and surfaces the failure to the user via the standard
    // error envelope rather than silently dropping the request.
    if !provider_supports_mode(&handle.runtime_provider, &new_mode) {
        send_error(
            sender,
            &envelope.id,
            "MODE_NOT_SUPPORTED",
            &format!(
                "Provider {} does not support permission mode {}",
                handle.runtime_provider, payload.mode
            ),
        );
        return;
    }

    info!(db_session_id, mode = %payload.mode, "updating permission mode");

    let active_query = match &handle.state {
        QueryState::Pending(_) => None,
        QueryState::Active { query, .. } => Some(query.clone()),
    };
    let applied = if let Some(query) = active_query {
        match apply_active_permission_mode(handle, query, db_session_id, new_mode, app_state).await
        {
            Ok(applied) => applied,
            Err(payload) => {
                send_mode_set_error(sender, &envelope.id, payload);
                return;
            }
        }
    } else {
        queue_pending_permission_mode(handle, new_mode);
        ModeApplied::Live
    };
    drop(sessions);

    // Persist to DB
    WsSessionPersistence::update_permission_mode_static(
        &app_state.write_pool,
        db_session_id,
        &payload.mode,
    )
    .await;

    // Reply to the caller and mirror to other devices so their mode chip updates.
    super::reply_and_broadcast(
        app_state,
        sender,
        &envelope.id,
        feature_id,
        &WsSessionEvent::ModeChanged(ModeChangedPayload { mode: payload.mode }),
    )
    .await;
    if matches!(applied, ModeApplied::Deferred) {
        notify_change_deferred(sender, &envelope.id, &["permission mode"]);
    }
}

/// How an active session took a permission-mode change.
enum ModeApplied {
    /// The live runtime switched (or was re-armed for the next prompt).
    Live,
    /// Enabling it needs a respawn, which would kill background work the
    /// runtime still owes the agent; the next free prompt applies it.
    Deferred,
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

fn queue_pending_permission_mode(
    handle: &mut super::super::SdkHandle,
    new_mode: RuntimePermissionMode,
) {
    // No live CLI yet; the queued mode will be passed via
    // `Options.permission_mode` at spawn time.
    handle.desired_permission_mode = Some(new_mode.clone());
    handle.config.permission_mode = Some(new_mode.clone());
    if let QueryState::Pending(options) = &mut handle.state {
        options.permission_mode = Some(new_mode);
    }
}

async fn apply_active_permission_mode(
    handle: &mut super::super::SdkHandle,
    query: RuntimeSessionHandle,
    db_session_id: i64,
    new_mode: RuntimePermissionMode,
    app_state: &AppState,
) -> Result<ModeApplied, SessionErrorPayload> {
    if should_rearm_bypass(handle, &new_mode, &app_state.read_pool).await {
        if runtime_is_held(db_session_id, &query) {
            // Re-arming closes the runtime, killing its background tasks and
            // pending wake-up. Record the mode; the prompt-time respawn arms
            // bypass once the runtime is free (`arm_bypass_for_respawn`).
            info!(
                db_session_id,
                "runtime owes a resume; deferring bypass re-arm"
            );
            handle.desired_permission_mode = Some(new_mode.clone());
            handle.config.permission_mode = Some(new_mode);
            return Ok(ModeApplied::Deferred);
        }
        rearm_claude_bypass_session(handle, query, db_session_id, new_mode, app_state).await;
        return Ok(ModeApplied::Live);
    }

    let q = query.read().await;
    if let Err(error) = q.set_permission_mode(new_mode.clone()).await {
        return Err(mode_set_error_payload(db_session_id, &new_mode, error));
    }
    handle.desired_permission_mode = Some(new_mode.clone());
    handle.config.permission_mode = Some(new_mode.clone());
    // Track what the CLI actually accepted. Without this,
    // `plan_post_plan_mode_transition`'s "already in target mode"
    // short-circuit (post_plan_mode.rs) reads stale state and
    // may skip the post-plan-approval transition.
    handle.spawned_permission_mode = Some(new_mode);
    Ok(ModeApplied::Live)
}

pub(in crate::domain::ws_session::handler) use crate::domain::ws_session::runtime::control_policy::should_rearm_bypass;

async fn rearm_claude_bypass_session(
    handle: &mut super::super::SdkHandle,
    query: RuntimeSessionHandle,
    db_session_id: i64,
    new_mode: RuntimePermissionMode,
    app_state: &AppState,
) {
    let runtime_session_id = persist_and_close_query(
        &query,
        app_state,
        db_session_id,
        &handle.runtime_provider,
        handle.feature_id,
    )
    .await;
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
