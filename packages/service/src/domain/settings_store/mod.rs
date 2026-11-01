//! JSON-file-backed store for global (workspace) and project settings.
//!
//! Settings used to live in the SQLite `settings` / `project_settings` tables
//! (plus a few real columns on `projects`). They now live as flat JSON
//! key/value files under the settings dir (`~/.cadencr/settings/`) so they can
//! be inspected and edited by external scripts:
//!
//! - global  → `settings.json`
//! - project → `<sanitized-name>.settings.json`. The path derives only from the
//!   name, so it is stable across project create/delete. Project names are not
//!   unique, and that is intentional: same name = same configuration file.
//!
//! Design notes:
//! - Reads always go to disk (no in-memory cache) so external edits are picked
//!   up immediately and there is no cache-invalidation surface to get wrong.
//! - Writes are atomic (temp file + rename) under a process-wide async lock so
//!   concurrent read-modify-write calls can't lose updates or expose a partial
//!   file to a reader.
//! - The loader is defensive: unknown keys produce a non-blocking warning but
//!   are preserved; values that fail type/enum validation fall back to the
//!   in-code default (see `registry`).
//!
//! The SQLite tables are intentionally left intact as a backup — this module
//! stops reading/writing them but never drops them.

pub mod dir;
pub mod ephemeral;
pub mod file;
pub mod generation;
pub mod lock;
pub mod migrate;
pub mod paths;
pub mod registry;
pub mod renamed_keys;
pub mod store;
pub mod validate;
pub mod watcher;

pub use dir::{global_dir, init};
pub use paths::name_is_shared;
pub use store::{
    global_get, global_get_nonempty, global_get_object, global_list, global_map,
    global_modify_object, global_read_for_edit, global_set, global_set_many, global_snapshot,
    global_write_content, project_get, project_list, project_map, project_path,
    project_read_for_edit, project_rename, project_set, project_set_many, project_write_content,
};

use serde::Serialize;
use tracing::{info, warn};
use utoipa::ToSchema;

/// One-time startup cleanups of the global settings file. Each step leaves a
/// missing or corrupt file untouched; a failure is logged and never blocks
/// startup.
pub async fn tidy_global_at_startup() {
    // Per-device UI state (active tab, sidebar visibility, last-opened feature)
    // now lives in the frontend's localStorage.
    match ephemeral::prune_ephemeral_global().await {
        Ok(true) => info!("pruned legacy per-device UI keys from settings.json"),
        Ok(false) => {}
        Err(e) => warn!("failed to prune ephemeral settings keys: {e}"),
    }
    match renamed_keys::carry_renamed_global_keys().await {
        Ok(true) => info!("carried renamed workspace keys over in settings.json"),
        Ok(false) => {}
        Err(e) => warn!("failed to carry renamed settings keys: {e}"),
    }
}

/// Which settings document a key/value lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Workspace,
    Project,
}

impl Scope {
    /// Whether `key` is a known/allowed key for this scope. Reuses the HTTP
    /// allowlist so the "known key" set has a single source of truth.
    pub fn is_key_known(&self, key: &str) -> bool {
        match self {
            Scope::Workspace => crate::domain::settings_allowlist::is_workspace_key_allowed(key),
            Scope::Project => crate::domain::settings_allowlist::is_project_key_allowed(key),
        }
    }

    pub fn spec(&self, key: &str) -> Option<registry::SettingSpec> {
        match self {
            Scope::Workspace => registry::workspace_spec(key),
            Scope::Project => registry::project_spec(key),
        }
    }
}

/// A non-blocking warning surfaced to the user when a settings file contains a
/// key/value the app can't fully honor. `key` is empty for file-level problems
/// (e.g. the document isn't valid JSON).
#[derive(Clone, Debug, Serialize, ToSchema)]
pub struct SettingWarning {
    pub key: String,
    pub message: String,
}

impl SettingWarning {
    pub fn new(key: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            message: message.into(),
        }
    }
}

/// Emitted when a settings file changes on disk (via our own writes or an
/// external editor). Broadcast to connected clients so the UI re-fetches.
#[derive(Clone, Debug, Serialize)]
pub struct SettingsChangeEvent {
    /// Changed file name, e.g. `settings.json` or `my-project.settings.json`.
    pub file: String,
}
