//! Resolves the provider/model/thinking triple for a conversation a schedule
//! creates.
//!
//! A schedule may pin any of them, but pinning none has to behave exactly like
//! pressing "New session" in that project — so the unset path walks the same
//! settings cascade the app does rather than hardcoding a provider.

use crate::app_state::AppState;
use crate::domain::agents::providers::{
    canonical_provider_or_error, resolve_effective_provider, runtime_adapter,
};
use crate::domain::agents::runtime::{runtime_setting_key, DEFAULT_PROVIDER};
use crate::domain::schedules::models::ScheduleTarget;
use crate::domain::schedules::pins::{
    access_mode_for, model_for, permission_mode_for, profile_for_new_session, trimmed,
};
use crate::domain::settings;
use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct ScheduleRuntime {
    pub provider: String,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub profile: Option<String>,
    pub permission_mode: Option<String>,
    pub codex_permission_mode: Option<String>,
}

pub async fn resolve(
    state: &AppState,
    project_id: i64,
    project_path: &str,
    target: &ScheduleTarget,
) -> Result<ScheduleRuntime, AppError> {
    let provider = resolve_provider(state, project_id, project_path, target).await?;
    // A pinned profile wins over the globally active one: that is the whole
    // point of pinning it — a scheduled run can bill against a different
    // account than the one the user happens to be working in today.
    let profile = trimmed(target.profile.as_deref()).or_else(|| profile_for_new_session(&provider));
    let model = model_for(
        &state.read_pool,
        Some(project_path),
        &provider,
        target.model.as_deref(),
        profile.as_deref(),
    )
    .await?;
    let permission_mode = permission_mode_for(&provider, target.permission_mode.as_deref())?;
    let codex_permission_mode = access_mode(state, &provider, target).await?;
    Ok(ScheduleRuntime {
        provider,
        model,
        thinking_level: trimmed(target.thinking_level.as_deref()),
        profile,
        permission_mode,
        codex_permission_mode,
    })
}

async fn resolve_provider(
    state: &AppState,
    project_id: i64,
    project_path: &str,
    target: &ScheduleTarget,
) -> Result<String, AppError> {
    if let Some(requested) = trimmed(target.provider.as_deref()) {
        return canonical_provider_or_error(&requested)
            .map_err(|error| AppError::BadRequest(error.to_string()));
    }
    let configured = settings::resolve_setting(
        &state.read_pool,
        &runtime_setting_key("session"),
        None,
        Some(project_id),
        Some(DEFAULT_PROVIDER),
    )
    .await
    .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let effective = resolve_effective_provider(
        &state.read_pool,
        Some(std::path::Path::new(project_path)),
        configured,
        target.model.as_deref(),
    )
    .await;
    canonical_provider_or_error(&effective).map_err(|error| AppError::BadRequest(error.to_string()))
}

/// The access mode the created session starts in.
///
/// A pin wins; otherwise the provider's configured default is carried forward,
/// because the session row is what the spawn path reads — leaving it empty
/// would start the run in the CLI's own default rather than the one the user
/// chose in settings. Providers without an access axis resolve to `None` and
/// the column keeps its `'default'` literal.
async fn access_mode(
    state: &AppState,
    provider: &str,
    target: &ScheduleTarget,
) -> Result<Option<String>, AppError> {
    if let Some(pinned) = access_mode_for(provider, target.access_mode.as_deref())? {
        return Ok(Some(pinned));
    }
    let Some(adapter) = runtime_adapter(provider) else {
        return Ok(None);
    };
    Ok(adapter
        .configured_access_mode(&state.read_pool)
        .await
        .map(|mode| crate::domain::agents::adapter::access_mode_wire(&mode).to_string()))
}
