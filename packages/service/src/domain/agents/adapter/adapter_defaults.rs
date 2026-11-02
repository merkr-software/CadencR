use std::borrow::Cow;
use std::path::Path;

use super::{RuntimeAccessMode, RuntimeError};

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
) -> RuntimeAccessMode {
    let configured = crate::domain::settings::resolve_setting(
        read_pool,
        setting_key,
        None,
        None,
        Some(super::access_mode_wire(&RuntimeAccessMode::Default)),
    )
    .await;
    configured
        .as_deref()
        .and_then(super::parse_access_mode_wire)
        .unwrap_or(RuntimeAccessMode::Default)
}
