use std::collections::HashMap;

use crate::app_state::AppState;
use crate::domain::agents::claude_code;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::PromptSendPayload;

use super::types::{QueryState, SdkHandle};

pub(super) struct SessionProfileUpdate {
    pub(super) name: String,
    env: Option<HashMap<String, String>>,
}

pub(super) fn prompt_profile(payload: &PromptSendPayload) -> Option<&str> {
    payload
        .profile
        .as_deref()
        .or(payload.claude_profile.as_deref())
}

pub(super) async fn resolve_provider_profile(
    _app_state: &AppState,
    provider: &str,
    profile: &str,
) -> Result<SessionProfileUpdate, String> {
    if provider != claude_code::PROVIDER_ID {
        return Ok(SessionProfileUpdate {
            name: profile.to_string(),
            env: None,
        });
    }
    let (name, env) = claude_code::profiles::resolve_profile_env_by_name(Some(profile))
        .map_err(|error| error.to_string())?;
    Ok(SessionProfileUpdate { name, env })
}

pub(super) fn desired_profile_name(handle: &SdkHandle) -> Option<&str> {
    if handle.runtime_provider == claude_code::PROVIDER_ID {
        return handle.desired_claude_profile.as_deref();
    }
    None
}

pub(super) fn apply_profile_update(handle: &mut SdkHandle, update: &SessionProfileUpdate) -> bool {
    if handle.runtime_provider != claude_code::PROVIDER_ID {
        return false;
    }
    let changed = handle.desired_claude_profile.as_deref() != Some(update.name.as_str())
        || handle.config.claude_profile.as_deref() != Some(update.name.as_str())
        || handle.config.env != update.env;
    handle.desired_claude_profile = Some(update.name.clone());
    handle.config.claude_profile = Some(update.name.clone());
    handle.config.env = update.env.clone();
    if let QueryState::Pending(options) = &mut handle.state {
        options.env = update.env.clone();
    }
    changed
}

pub(super) async fn resolve_initial_claude_profile(
    app_state: &AppState,
    db_session_id: i64,
    stored_profile: Option<&str>,
) -> (String, Option<HashMap<String, String>>) {
    if let Some(profile) = stored_profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return claude_code::profiles::resolve_profile_env_by_name(Some(profile))
            .unwrap_or_else(|error| {
            tracing::warn!(
                db_session_id,
                profile,
                %error,
                "stored Claude profile could not be resolved; keeping session profile without env"
            );
            (profile.to_string(), None)
        });
    }

    let (profile, env) = claude_code::profiles::resolve_active_profile_env();
    WsSessionPersistence::update_profile_static(&app_state.write_pool, db_session_id, &profile)
        .await;
    (profile, env)
}
