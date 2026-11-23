//! Workspace model discovery and catalog projections for installed ACP providers.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::catalog_cache::CachedCatalog;
use crate::domain::agents::runtime::{ProviderCatalogEntry, ProviderStatus};

use super::super::installation::HostInstallation;
use super::super::model_discovery::{discover_models, DiscoveredModels};
use super::{DiscoveredControls, GenericAcpAdapter, InstalledCatalogCache};

impl GenericAcpAdapter {
    pub(super) async fn cached_catalog_for_cwd(
        &self,
        cwd: &Path,
    ) -> CachedCatalog<Option<DiscoveredModels>> {
        discover_cached(&self.catalog_cache, &self.installation, &self.controls, cwd).await
    }

    pub(super) async fn discover_for_cwd(
        &self,
        cwd: &Path,
    ) -> Result<DiscoveredModels, RuntimeError> {
        let entry = self.cached_catalog_for_cwd(cwd).await;
        if let Some(discovered) = entry.extra.as_ref() {
            return Ok(discovered.clone());
        }
        Err(RuntimeError::new(
            entry
                .catalog
                .status_message
                .clone()
                .unwrap_or_else(|| "model discovery failed".to_string()),
        ))
    }

    pub(super) fn unavailable_catalog(&self, message: impl AsRef<str>) -> ProviderCatalogEntry {
        with_installation_icon(
            &self.installation,
            ProviderCatalogEntry::unavailable(
                self.installation.provider_id(),
                self.installation.agent().name.clone(),
                message.as_ref(),
            ),
        )
    }
}

pub(super) fn default_cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

pub(super) fn with_installation_icon(
    installation: &HostInstallation,
    mut entry: ProviderCatalogEntry,
) -> ProviderCatalogEntry {
    entry.icon_data = installation.icon_data().map(str::to_string);
    entry
}

fn discovered_catalog_entry(
    installation: &HostInstallation,
    discovered: &DiscoveredModels,
) -> ProviderCatalogEntry {
    let agent = installation.agent();
    ProviderCatalogEntry {
        id: agent.id.clone(),
        label: agent.name.clone(),
        icon_data: None,
        status: ProviderStatus::Available,
        status_message: None,
        refresh_error: None,
        modes: discovered.modes.mode_catalog(),
        access_modes: discovered.modes.access_mode_catalog(),
        models: discovered.models.clone(),
        default_model: Some(discovered.default_model.clone()),
    }
}

pub(super) async fn discover_cached(
    catalog_cache: &Arc<InstalledCatalogCache>,
    installation: &Arc<HostInstallation>,
    controls: &Arc<RwLock<DiscoveredControls>>,
    cwd: &Path,
) -> CachedCatalog<Option<DiscoveredModels>> {
    let cwd_owned = cwd.to_path_buf();
    let installation = Arc::clone(installation);
    let controls = Arc::clone(controls);
    catalog_cache
        .get_or_revalidate(cwd_owned.clone(), move || {
            let installation = Arc::clone(&installation);
            let controls = Arc::clone(&controls);
            let cwd = cwd_owned.clone();
            async move {
                let executable = installation.launchable().map_err(RuntimeError::new)?;
                let discovered = discover_models(executable, &cwd).await.map_err(|error| {
                    RuntimeError::new(format!("model discovery failed: {error}"))
                })?;
                *controls
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = DiscoveredControls {
                    modes: Arc::new(discovered.modes.clone()),
                    prompt_steering: discovered.prompt_steering,
                };
                let entry = discovered_catalog_entry(&installation, &discovered);
                Ok((entry, Some(discovered)))
            }
        })
        .await
}
