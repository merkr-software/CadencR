use std::borrow::Cow;
use std::path::Path;

use super::{
    RuntimeAccessMode, RuntimeConfigOverrides, RuntimeEffectiveConfig, RuntimeError, RuntimeEvent,
};

/// What a provider without profiles runs: exactly the requested overrides.
pub(super) fn effective_config(overrides: &RuntimeConfigOverrides) -> RuntimeEffectiveConfig {
    RuntimeEffectiveConfig {
        model: overrides.model.clone(),
        thinking_effort: overrides.thinking_effort.clone(),
        fast_mode: overrides.fast_mode.unwrap_or(false),
    }
}

/// The context window an event reports through normalized metadata only.
pub(super) fn context_window_for_event(runtime_event: &RuntimeEvent) -> Option<u64> {
    runtime_event
        .context_window()
        .or_else(|| runtime_event.init().and_then(|init| init.context_window))
}

pub(super) fn slash_command_refresh_unsupported() -> RuntimeError {
    RuntimeError::new("runtime slash command refresh is not supported by this provider")
}

pub(super) async fn copy_worktree_config(
    label: &str,
    source: &Path,
    target: &Path,
    paths: &[Cow<'static, str>],
) -> Result<(), RuntimeError> {
    if paths.is_empty() {
        return Ok(());
    }
    crate::domain::agents::config_migration::copy_provider_config_paths(
        label, source, target, paths,
    )
    .await
}

pub(super) async fn configured_access_mode(
    read_pool: &sqlx::SqlitePool,
    setting_key: &str,
) -> Result<RuntimeAccessMode, crate::error::AppError> {
    let configured = crate::domain::settings::resolve_setting(
        read_pool,
        setting_key,
        None,
        None,
        Some(super::access_mode_wire(&RuntimeAccessMode::Default)),
    )
    .await?;
    Ok(configured
        .as_deref()
        .and_then(super::parse_access_mode_wire)
        .unwrap_or(RuntimeAccessMode::Default))
}
