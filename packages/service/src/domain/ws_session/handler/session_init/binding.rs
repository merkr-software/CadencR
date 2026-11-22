//! Reconnect snapshots come from the authoritative runtime, never a replacement.

use crate::app_state::AppState;
use crate::domain::agents::adapter::{access_mode_wire, RuntimeSessionHandle};
use crate::domain::agents::permission_modes::permission_mode_wire;
use crate::domain::agents::runtime_adapter;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::protocol::{SessionInitializedPayload, WsEnvelope, WsSessionEvent};
use crate::shared::discard::IgnoreClosed;

use super::super::{QueryState, SdkHandle, SdkSessions, SessionConfig, WsSender};

pub(super) fn live_payload(
    id: i64,
    handle: &SdkHandle,
    row: Option<&SessionRow>,
    spawning: bool,
) -> Option<(SessionInitializedPayload, Option<RuntimeSessionHandle>)> {
    let live_query = match &handle.state {
        QueryState::Active { query, .. } => Some(query.clone()),
        QueryState::Pending(_) if spawning => None,
        QueryState::Pending(_) => return None,
    };
    let access_mode = handle
        .desired_access_mode
        .as_ref()
        .map(access_mode_wire)
        .map(str::to_owned);
    let payload = SessionInitializedPayload {
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
    };
    Some((payload, live_query))
}

pub(super) async fn reply_and_restore(
    state: &AppState,
    sender: &WsSender,
    ref_id: &str,
    payload: SessionInitializedPayload,
    feature_id: i64,
    resume_id: Option<&str>,
    runtime: Option<(&SdkSessions, RuntimeSessionHandle)>,
) {
    let id = payload
        .session_id
        .parse()
        .expect("initialized session id is numeric");
    let reply = WsEnvelope::session_reply(ref_id, &WsSessionEvent::Initialized(payload))
        .expect("session event payload should serialize");
    sender
        .send(axum::extract::ws::Message::Text(String::from(reply).into()))
        .ignore_closed();
    if let Some((sessions, query)) = runtime {
        crate::domain::ws_session::runtime::prompt::mcp_servers::replay_cached_mcp_servers(
            sessions, id, &query, sender,
        )
        .await;
    }
    state.persistence_health.replay(id, sender).await;
    if let Some(resume_id) = resume_id {
        super::super::send_runtime_session_id(sender, resume_id);
    }
    super::restore::restore_pending_or_idle(state, sender, id, feature_id).await;
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
        manual_compact_start: Default::default(),
        manual_compact_spawn_pending: std::sync::Arc::default(),
    }
}

/// The session row `session.init` resumes from. Without it a resumed
/// conversation would start a fresh agent with no resume id, so a failed read
/// is answered with `DB_ERROR` and stops the init.
pub(super) async fn read_row(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    db_session_id: i64,
) -> Result<Option<SessionRow>, ()> {
    WsSessionPersistence::get_session_row(&app_state.read_pool, db_session_id)
        .await
        .map_err(|error| {
            let message = format!("Failed to read the session: {error}");
            super::super::send_error(sender, envelope_id, "DB_ERROR", &message);
        })
}
