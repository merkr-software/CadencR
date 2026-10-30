//! Reconnect snapshots come from the authoritative runtime, never a replacement.

use crate::app_state::AppState;
use crate::domain::agents::adapter::access_mode_wire;
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::agents::runtime_adapter;
use crate::domain::ws_session::persistence::SessionRow;
use crate::domain::ws_session::protocol::{SessionInitializedPayload, WsEnvelope, WsSessionEvent};

use super::super::{QueryState, SdkHandle, SessionConfig, WsSender};

pub(super) fn live_payload(
    id: i64,
    handle: &SdkHandle,
    row: Option<&SessionRow>,
    spawning: bool,
) -> Option<SessionInitializedPayload> {
    if !spawning && !matches!(handle.state, QueryState::Active { .. }) {
        return None;
    }
    let access_mode = handle
        .desired_access_mode
        .as_ref()
        .map(access_mode_wire)
        .map(str::to_owned);
    Some(SessionInitializedPayload {
        session_id: id.to_string(),
        provider: Some(handle.runtime_provider.clone()),
        model: handle.desired_model.clone(),
        thinking_effort: handle.desired_thinking_effort.clone(),
        fast_mode: handle.config.fast_mode,
        profile: handle.desired_claude_profile.clone(),
        runtime_overrides: handle.config.overrides.clone(),
        permission_mode: handle
            .desired_permission_mode
            .as_ref()
            .map(permission_mode_wire),
        codex_permission_mode: runtime_adapter(&handle.runtime_provider)
            .and_then(|adapter| adapter.legacy_access_mode_wire(access_mode.as_deref())),
        access_mode,
        input_tokens: row.and_then(|row| row.input_tokens).map(|v| v as u64),
        output_tokens: row.and_then(|row| row.output_tokens).map(|v| v as u64),
        context_window: row.and_then(|row| row.context_window).map(|v| v as u64),
        supports_prompt_receipts: runtime_adapter(&handle.runtime_provider)
            .is_some_and(|adapter| adapter.supports_prompt_receipts()),
    })
}

pub(super) async fn reply_and_restore(
    state: &AppState,
    sender: &WsSender,
    ref_id: &str,
    payload: SessionInitializedPayload,
    feature_id: i64,
    resume_id: Option<&str>,
) {
    let id = payload
        .session_id
        .parse()
        .expect("initialized session id is numeric");
    let reply = WsEnvelope::session_reply(ref_id, &WsSessionEvent::Initialized(payload))
        .expect("session event payload should serialize");
    let _ = sender.send(axum::extract::ws::Message::Text(String::from(reply).into()));
    state.persistence_health.replay(id, sender).await;
    if let Some(resume_id) = resume_id {
        super::super::send_runtime_session_id(sender, resume_id);
    }
    super::session_init_restore::restore_pending_or_idle(state, sender, id, feature_id).await;
    if let Err(error) =
        super::super::session_init_worktree::restore_worktree_state(state, sender, feature_id).await
    {
        super::super::send_error(sender, ref_id, "WORKTREE_CHECK_FAILED", &error);
    }
}

#[bon::builder]
pub(super) fn pending_handle(
    runtime_config: crate::domain::agents::adapter::RuntimeSpawnConfig,
    feature_id: i64,
    runtime_provider: String,
    profile: Option<String>,
    resume_session_id: Option<String>,
) -> SdkHandle {
    let config = SessionConfig::from_runtime(&runtime_config, profile.clone());
    SdkHandle {
        identity: crate::domain::ws_session::runtime::state::RuntimeHandleIdentity::default(),
        feature_id,
        runtime_provider,
        config,
        resume_session_id,
        desired_model: runtime_config.model.clone(),
        desired_permission_mode: runtime_config.permission_mode.clone(),
        desired_access_mode: runtime_config.access_mode.clone(),
        desired_thinking_effort: runtime_config.thinking_effort.clone(),
        desired_claude_profile: profile,
        state: QueryState::Pending(runtime_config),
        spawned_model: None,
        spawned_permission_mode: None,
        spawned_access_mode: None,
        spawned_thinking_effort: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        manual_compact_cancel: std::sync::Arc::default(),
        manual_compact_spawn_pending: std::sync::Arc::default(),
    }
}
