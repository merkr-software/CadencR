//! Bind the JSON settings directory before anything reads settings.

use std::path::PathBuf;

use super::database::Pools;
use crate::config::Config;
use crate::domain;

/// Resolve the JSON settings dir, migrate legacy SQLite settings into it
/// (idempotent + non-destructive), and make it the process-wide settings
/// location BEFORE anything reads settings (binary overrides, remote
/// auto-start, agent warmups all do).
pub(super) async fn prepare(
    config: &Config,
    db_path: &str,
    pools: &Pools,
) -> anyhow::Result<PathBuf> {
    let settings_dir =
        domain::settings_store::dir::resolve_from_config(config.settings_dir.as_deref(), db_path);
    domain::settings_store::dir::secure(&settings_dir)?;
    // Resolve to an absolute path so the "Edit JSON" / "Copy path" UI
    // shows a usable location. In dev the dir derives from a relative
    // `--db-path`, which would otherwise surface as a confusing
    // CWD-relative `./cadencr-settings/settings.json`.
    let settings_dir = std::fs::canonicalize(&settings_dir).unwrap_or(settings_dir);
    domain::settings_store::init(settings_dir.clone());
    domain::telemetry::initialize(config.app_version.as_deref());
    domain::agents::providers::installed::managed::trust::initialize_pinned_registry_trust()
        .await?;
    // Bind the provider registry to that settings dir immediately: it
    // scans `<settings-dir>/providers` exactly once, and a lazy first
    // lookup before this point would cache an empty scan of the
    // uninitialized fallback path for the life of the process.
    domain::agents::providers::provider_registry();
    domain::settings_store::migrate::migrate_from_sqlite(&pools.read, &settings_dir).await;
    // Claude Code profiles moved out of SQLite into the nested `profiles`
    // section of settings.json — copy any legacy rows over, then drop the
    // table. Needs `write_pool` for the DROP and must run after the dir is
    // initialized so the JSON write lands in the right place.
    domain::agents::claude_code::profiles::migrate_from_sqlite(&pools.write).await;
    // Strip per-device UI state older versions wrote into the global
    // file and carry renamed workspace keys over.
    domain::settings_store::tidy_global_at_startup().await;
    Ok(settings_dir)
}
