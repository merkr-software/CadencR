use crate::app_state::AppState;
use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeSpawnConfig};
use crate::domain::ws_session::persistence::WsSessionPersistence;

use super::default_permission_mode;

pub(in crate::domain::ws_session) async fn apply_provider_settings(
    app_state: &AppState,
    project_id: i64,
    feature_id: i64,
    db_session_id: i64,
    provider: &str,
    stored_profile: Option<&str>,
    runtime_config: &mut RuntimeSpawnConfig,
) -> Result<Option<String>, String> {
    let adapter = crate::domain::agents::providers::runtime_adapter(provider)
        .ok_or_else(|| format!("provider '{provider}' is not available"))?;
    let resolved = adapter
        .resolve_profile(stored_profile, &runtime_config.cwd)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(profile) = resolved {
        runtime_config.profile = Some(profile.identity.clone());
        runtime_config.env = (!profile.env.is_empty()).then_some(profile.env);
        runtime_config.env_unset = profile.env_unset;
        runtime_config.profile_revision = Some(profile.revision);
        runtime_config.profile_state_identity = profile.state_identity;
        if stored_profile.is_none() {
            WsSessionPersistence::update_profile_static(
                &app_state.write_pool,
                db_session_id,
                &profile.identity,
            )
            .await;
        }
    }

    let Some(allow_bypass_permissions) = adapter
        .bypass_permission_opt_in(&app_state.read_pool, feature_id, Some(project_id))
        .await
    else {
        return Ok(runtime_config.profile.clone());
    };

    runtime_config.allow_bypass_permissions = allow_bypass_permissions;

    if !allow_bypass_permissions
        && runtime_config.permission_mode == Some(RuntimePermissionMode::BypassPermissions)
    {
        tracing::warn!(
            db_session_id,
            feature_id,
            "bypassPermissions requested without provider bypass opt-in; \
             downgrading to provider default"
        );
        runtime_config.permission_mode = Some(default_permission_mode(provider));
    }

    Ok(runtime_config.profile.clone())
}

pub(in crate::domain::ws_session) async fn persisted_profile_selection(
    provider: &str,
    persisted_profile: Option<&str>,
    runtime_session_id: Option<&str>,
    cwd: &std::path::Path,
) -> Result<Option<String>, String> {
    if let Some(profile) = persisted_profile {
        return Ok(Some(profile.to_string()));
    }
    if runtime_session_id.is_none() {
        return Ok(None);
    }
    let adapter = crate::domain::agents::providers::runtime_adapter(provider)
        .ok_or_else(|| format!("provider '{provider}' is not available"))?;
    if !adapter.supports_profile_config_inheritance() {
        return Ok(None);
    }
    adapter
        .profile_catalog(Some(cwd))
        .await
        .map_err(|error| error.to_string())
        .map(|catalog| catalog.map(|profiles| profiles.default_profile))
}
