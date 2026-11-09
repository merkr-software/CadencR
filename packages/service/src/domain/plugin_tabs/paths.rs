//! Where custom tabs live on disk, and what an id is allowed to be.

use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use cadencr_plugin_core::tab::is_valid_tab_id;

use crate::error::AppError;

/// `~/.cadencr/plugins/tabs` in production: the sibling of `plugins/themes`,
/// never inside the app bundle. Per-test isolated in test builds (see
/// `settings_store::dir::sibling_dir`) — resolve it *before* `spawn_blocking`.
pub fn tabs_dir() -> PathBuf {
    crate::domain::settings_store::dir::data_sibling_dir("plugins").join("tabs")
}

/// The writable folder of tab `id`'s backend (`~/.cadencr/plugins/tab-state/<id>`
/// in production), outside the tab folder: a marketplace revision is
/// immutable, and storage retention must never find a backend's files in it.
/// `id` must already be a valid tab id.
pub fn state_dir(id: &str) -> PathBuf {
    crate::domain::settings_store::dir::data_sibling_dir("plugins")
        .join("tab-state")
        .join(id)
}

/// The folder of tab `id`. Refuses anything that is not a tab id — the id is a
/// path segment here and a URL host label in the Electron host, so `.`, `/`
/// and uppercase can never reach either.
pub fn plugin_dir(id: &str) -> Result<PathBuf, AppError> {
    resolve_plugin_directory()
        .id(id)
        .local_root(&tabs_dir())
        .managed_root(&super::managed::storage::root())
        .call()
        .map(|selected| selected.directory().to_owned())
}

pub enum PluginDirectory {
    Local(PathBuf),
    Managed(super::managed::storage::RevisionLease),
}

impl PluginDirectory {
    pub fn directory(&self) -> &Path {
        match self {
            Self::Local(path) => path,
            Self::Managed(lease) => lease.directory(),
        }
    }

    pub fn into_lease(self) -> Option<super::managed::storage::RevisionLease> {
        match self {
            Self::Local(_) => None,
            Self::Managed(lease) => Some(lease),
        }
    }
}

/// Managed selection and pinning are one operation; never preflight its pointer
/// without a lease. Explicit roots preserve test-thread settings isolation when
/// this filesystem work runs on a blocking worker.
#[bon::builder]
pub fn resolve_plugin_directory(
    id: &str,
    local_root: &Path,
    managed_root: &Path,
) -> Result<PluginDirectory, AppError> {
    if !is_valid_tab_id(id) {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "PLUGIN_TAB_ID_INVALID",
            format!("`{id}` is not a valid custom tab id"),
        ));
    }
    let local = local_root.join(id);
    match local.symlink_metadata() {
        Ok(_) => return Ok(PluginDirectory::Local(local)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(AppError::internal(format!(
                "cannot inspect local tab: {error}"
            )))
        }
    }
    Ok(match super::managed::storage::lease(managed_root, id)? {
        Some(lease) => PluginDirectory::Managed(lease),
        None => PluginDirectory::Local(local),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_dir_is_the_themes_sibling_under_plugins() {
        let dir = tabs_dir();
        assert_eq!(dir.file_name().unwrap(), "tabs");
        assert_eq!(dir.parent().unwrap().file_name().unwrap(), "plugins");
        assert_eq!(
            dir.parent().unwrap(),
            crate::domain::themes::paths::themes_dir().parent().unwrap()
        );
    }

    #[test]
    fn plugin_dir_refuses_traversal_and_non_label_ids() {
        for id in ["", "..", "../x", "a/b", "A", "-a", "a.b", "a b"] {
            assert!(plugin_dir(id).is_err(), "{id}");
        }
        assert_eq!(plugin_dir("graph").unwrap(), tabs_dir().join("graph"));
    }

    #[test]
    fn managed_resolution_pins_before_inspection_and_preserves_local_precedence() {
        use super::super::managed::storage::{self, fixtures::fixture_revision};
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        let root = temp.path().join("managed");
        let install = |revision| {
            let (receipt, archive, files, _) =
                fixture_revision(&temp.path().join(format!("fixture-{revision}")), revision);
            storage::commit(&root, &receipt, &archive, &files).unwrap();
        };
        let resolve = || {
            resolve_plugin_directory()
                .id("graph")
                .local_root(&local)
                .managed_root(&root)
                .call()
                .unwrap()
        };
        install(0);
        let selected = resolve();
        assert!(matches!(selected, PluginDirectory::Managed(_)));
        let original = selected.directory().to_owned();
        install(1);
        install(2);
        assert!(original.exists());
        assert_eq!(
            cadencr_plugin_core::tab::inspect_tab_folder(selected.directory())
                .valid_manifest()
                .unwrap()
                .version,
            "1.0.0"
        );
        drop(selected);
        install(3);
        assert!(!original.exists());
        std::fs::create_dir_all(local.join("graph")).unwrap();
        assert!(matches!(resolve(), PluginDirectory::Local(_)));
    }
}
