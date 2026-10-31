use std::collections::HashMap;

use crate::domain::agents::providers::runtime_adapter;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::state::{QueryState, SdkHandle};

pub(in crate::domain::ws_session) struct SessionProfileUpdate {
    pub(in crate::domain::ws_session) name: String,
    env: Option<HashMap<String, String>>,
    env_unset: Vec<String>,
    revision: String,
    state_identity: Option<String>,
}

pub(in crate::domain::ws_session) fn prompt_profile(payload: &PromptSendPayload) -> Option<&str> {
    payload
        .profile
        .as_deref()
        .or(payload.claude_profile.as_deref())
}

pub(in crate::domain::ws_session) async fn resolve_provider_profile(
    provider: &str,
    profile: &str,
    cwd: &std::path::Path,
) -> Result<SessionProfileUpdate, String> {
    let adapter = runtime_adapter(provider)
        .ok_or_else(|| format!("provider '{provider}' is not available"))?;
    let resolved = adapter
        .resolve_profile(Some(profile), cwd)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("provider '{provider}' does not support profiles"))?;
    Ok(SessionProfileUpdate {
        name: resolved.identity,
        env: (!resolved.env.is_empty()).then_some(resolved.env),
        env_unset: resolved.env_unset,
        revision: resolved.revision,
        state_identity: resolved.state_identity,
    })
}

pub(in crate::domain::ws_session) fn desired_profile_name(handle: &SdkHandle) -> Option<&str> {
    handle.desired_claude_profile.as_deref()
}

pub(in crate::domain::ws_session) fn apply_profile_update(
    handle: &mut SdkHandle,
    update: &SessionProfileUpdate,
) -> bool {
    let changed = handle.desired_claude_profile.as_deref() != Some(update.name.as_str())
        || handle.config.claude_profile.as_deref() != Some(update.name.as_str())
        || handle.config.env != update.env
        || handle.config.profile_revision.as_deref() != Some(update.revision.as_str())
        || handle.config.profile_state_identity != update.state_identity;
    handle.desired_claude_profile = Some(update.name.clone());
    handle.config.claude_profile = Some(update.name.clone());
    handle.config.env = update.env.clone();
    handle.config.env_unset = update.env_unset.clone();
    handle.config.profile_revision = Some(update.revision.clone());
    handle.config.profile_state_identity = update.state_identity.clone();
    handle.config.runtime_overrides_dirty |= changed;
    if let QueryState::Pending(options) = &mut handle.state {
        options.env = update.env.clone();
        options.env_unset = update.env_unset.clone();
        options.profile = Some(update.name.clone());
        options.profile_revision = Some(update.revision.clone());
        options.profile_state_identity = update.state_identity.clone();
    }
    tracing::debug!(profile_revision = %update.revision, state_identity = ?update.state_identity, "resolved provider profile update");
    changed
}

pub(in crate::domain::ws_session) fn validate_resume_profile_state(
    handle: &SdkHandle,
    update: &SessionProfileUpdate,
) -> Result<(), String> {
    let has_runtime_state = handle.resume_session_id.is_some()
        || matches!(handle.state, QueryState::Active { .. })
        || matches!(&handle.state, QueryState::Pending(options) if options.resume_session_id.is_some());
    if has_runtime_state
        && handle.config.profile_state_identity.is_some()
        && handle.config.profile_state_identity != update.state_identity
    {
        return Err("selected profile uses a different provider state home; fork a new conversation instead of resuming this one".to_string());
    }
    Ok(())
}
