//! What a tab is right now, read cheaply: enough for a request to tell
//! whether a backend started earlier still runs the tab as it is.

use std::path::{Path, PathBuf};

use cadencr_plugin_core::tab::read_tab_manifest;

use super::super::paths::{self, PluginDirectory};
use crate::error::AppError;

/// The folder tab `id` resolves to now, canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurrentRevision {
    /// A local tab: its `tab.json` can change in place, so it carries the
    /// permissions hash of the manifest as it is now (`None` when it cannot
    /// be read).
    Local {
        directory: PathBuf,
        permissions_hash: Option<String>,
    },
    /// A marketplace tab's active revision: sealed and named after its
    /// content, so the same folder is the same manifest and binary.
    Managed { directory: PathBuf },
}

impl CurrentRevision {
    pub fn directory(&self) -> &Path {
        match self {
            Self::Local { directory, .. } | Self::Managed { directory } => directory,
        }
    }
}

/// Tab `id`'s [`CurrentRevision`]: no validation, icon, staged update,
/// signed facts or binary probe.
pub async fn current_revision(id: &str) -> Result<CurrentRevision, AppError> {
    let local_root = paths::tabs_dir();
    let managed_root = super::super::managed::storage::root();
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let selected = paths::resolve_plugin_directory()
            .id(&id)
            .local_root(&local_root)
            .managed_root(&managed_root)
            .call()?;
        let directory = selected.directory().canonicalize().map_err(|error| {
            AppError::internal(format!("cannot open custom tab `{id}`: {error}"))
        })?;
        Ok(match selected {
            PluginDirectory::Managed(_) => CurrentRevision::Managed { directory },
            PluginDirectory::Local(_) => CurrentRevision::Local {
                permissions_hash: read_tab_manifest(&directory)
                    .map(|manifest| manifest.permissions_hash_with_backend_digest(None)),
                directory,
            },
        })
    })
    .await
    .map_err(|error| AppError::internal(format!("custom tab read failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::registry;
    use crate::domain::plugin_tabs::test_support::write_tab;

    #[tokio::test]
    async fn a_local_tab_reads_as_its_folder_and_current_hash() {
        write_tab("graph", serde_json::json!({}));
        let tab = registry::get("graph").await.unwrap();
        let current = current_revision("graph").await.unwrap();
        assert_eq!(
            current,
            CurrentRevision::Local {
                directory: tab.report.directory.clone(),
                permissions_hash: tab.permissions_hash(),
            }
        );
        write_tab(
            "graph",
            serde_json::json!({"permissions": ["features:read"]}),
        );
        let CurrentRevision::Local {
            permissions_hash, ..
        } = current_revision("graph").await.unwrap()
        else {
            panic!("a local tab");
        };
        assert_ne!(permissions_hash, tab.permissions_hash());
        assert!(current_revision("absent").await.is_err());
    }
}
