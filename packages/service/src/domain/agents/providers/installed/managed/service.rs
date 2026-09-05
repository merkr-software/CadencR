//! Managed-provider package lifecycle orchestration.

use std::path::PathBuf;
use std::time::Duration;

use super::history::ManagedProviderState;
use super::installer::ManagedStorage;
use super::receipt::{ManagedPackageReceipt, ManagedRevision};
use super::trust::{pinned_index_trust_store, ManagedTrustStore};
use super::SignedManagedProviderIndex;
use crate::error::AppError;

mod install;
mod inventory;

pub use inventory::{
    ManagedBlocklistCacheStatus, ManagedBlocklistInventory, ManagedBlocklistRefreshInventory,
    ManagedBlocklistRefreshOutcome, ManagedProviderInventoryEntry, ManagedProvidersInventory,
    ManagedTrustConfigurationStatus, ManagedTrustInventory,
};

#[derive(Clone, bon::Builder)]
pub struct ManagedProviderService {
    client: reqwest::Client,
    storage: ManagedStorage,
    descriptors: PathBuf,
    trust_store: ManagedTrustStore,
}

#[derive(Debug)]
pub struct ManagedMutation {
    pub state: ManagedProviderState,
    pub receipt: Option<ManagedPackageReceipt>,
}

impl ManagedProviderService {
    pub fn production() -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|error| AppError::Internal(format!("build provider HTTP client: {error}")))?;
        Ok(Self {
            client,
            storage: ManagedStorage::production(),
            descriptors: super::super::descriptors_dir(),
            trust_store: pinned_index_trust_store(),
        })
    }

    pub async fn install(
        &self,
        provider_id: &str,
        version: &str,
        index: SignedManagedProviderIndex,
    ) -> Result<ManagedMutation, AppError> {
        install::ingest(
            self,
            provider_id,
            version,
            index,
            install::IngestKind::Install,
        )
        .await
    }

    pub async fn update(
        &self,
        provider_id: &str,
        version: &str,
        index: SignedManagedProviderIndex,
    ) -> Result<ManagedMutation, AppError> {
        install::ingest(
            self,
            provider_id,
            version,
            index,
            install::IngestKind::Update,
        )
        .await
    }

    pub async fn rollback(
        &self,
        provider_id: &str,
        revision: &ManagedRevision,
    ) -> Result<ManagedMutation, AppError> {
        install::rollback(self, provider_id, revision).await
    }

    pub async fn set_enabled(
        &self,
        provider_id: &str,
        enabled: bool,
    ) -> Result<ManagedMutation, AppError> {
        let state =
            super::installer::set_enabled(&self.storage, &self.descriptors, provider_id, enabled)
                .await?;
        Ok(ManagedMutation {
            state,
            receipt: None,
        })
    }

    pub async fn remove(&self, provider_id: &str) -> Result<ManagedMutation, AppError> {
        let state = super::installer::remove(&self.storage, &self.descriptors, provider_id).await?;
        Ok(ManagedMutation {
            state,
            receipt: None,
        })
    }

    pub async fn inventory(&self) -> Result<ManagedProvidersInventory, AppError> {
        let storage = self.storage.clone();
        let descriptors = self.descriptors.clone();
        // Capture the startup snapshot on the request thread: test settings paths
        // are thread-local and must not be resolved inside spawn_blocking.
        let boot = super::super::startup_load();
        tokio::task::spawn_blocking(move || inventory::inventory(&storage, &descriptors, &boot))
            .await
            .map_err(|error| {
                AppError::Internal(format!("managed inventory task failed: {error}"))
            })?
    }

    pub async fn inventory_entry(
        &self,
        provider_id: &str,
    ) -> Result<ManagedProviderInventoryEntry, AppError> {
        let storage = self.storage.clone();
        let descriptors = self.descriptors.clone();
        let provider_id = provider_id.to_string();
        let boot = super::super::startup_load();
        tokio::task::spawn_blocking(move || {
            inventory::inventory_entry(&storage, &descriptors, &provider_id, &boot)
        })
        .await
        .map_err(|error| AppError::Internal(format!("managed inventory task failed: {error}")))
    }

    pub async fn refresh_blocklist(&self) -> Result<bool, AppError> {
        let Some(url) = super::blocklist::pinned_blocklist_url() else {
            return Err(AppError::coded(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "MANAGED_BLOCKLIST_SOURCE_NOT_CONFIGURED",
                "managed provider blocklist source is not configured in this build",
            ));
        };
        match super::blocklist::refresh_blocklist(
            &self.client,
            url,
            &self.storage.blocklist_cache_path(),
            &self.trust_store,
        )
        .await
        {
            Ok(verified) => {
                inventory::record_blocklist_refresh(
                    ManagedBlocklistRefreshOutcome::Refreshed,
                    None,
                );
                tracing::info!(
                    signer_key_id = verified.signer_key_id(),
                    "refreshed managed provider blocklist"
                );
                Ok(true)
            }
            Err(download_error) => {
                let cached = super::blocklist::load_cached_blocklist(
                    &self.storage.blocklist_cache_path(),
                    &self.trust_store,
                    chrono::Utc::now(),
                );
                match cached {
                    Ok(Some(_)) => {
                        inventory::record_blocklist_refresh(
                            ManagedBlocklistRefreshOutcome::UsedCachedVerifiedPolicy,
                            Some((download_error.code.as_str(), &download_error.message)),
                        );
                        Ok(false)
                    }
                    Ok(None) => {
                        inventory::record_blocklist_refresh(
                            ManagedBlocklistRefreshOutcome::Failed,
                            Some((download_error.code.as_str(), &download_error.message)),
                        );
                        Err(AppError::coded(
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            download_error.code.as_str(),
                            download_error.message,
                        ))
                    }
                    Err(cache_error) => {
                        inventory::record_blocklist_refresh(
                            ManagedBlocklistRefreshOutcome::Failed,
                            Some((cache_error.code.as_str(), &cache_error.message)),
                        );
                        Err(AppError::coded(
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            cache_error.code.as_str(),
                            cache_error.message,
                        ))
                    }
                }
            }
        }
    }
}

/// Refresh the release-owned blocklist without delaying service startup.
/// Launches remain protected by the last still-valid verified cache while the
/// network request is in flight or unavailable.
pub fn spawn_startup_blocklist_refresh() {
    if super::blocklist::pinned_blocklist_url().is_none() {
        return;
    }
    let service = match ManagedProviderService::production() {
        Ok(service) => service,
        Err(error) => {
            let message = error.to_string();
            inventory::record_blocklist_refresh(
                ManagedBlocklistRefreshOutcome::Failed,
                Some(("MANAGED_BLOCKLIST_CLIENT_INIT_FAILED", &message)),
            );
            tracing::error!(%error, "could not initialize managed-provider blocklist refresh");
            return;
        }
    };
    tokio::spawn(async move {
        match service.refresh_blocklist().await {
            Ok(true) => tracing::info!("managed-provider blocklist refreshed at startup"),
            Ok(false) => tracing::warn!(
                "managed-provider blocklist refresh failed; using verified cached policy"
            ),
            Err(error) => tracing::error!(%error, "managed-provider blocklist refresh failed"),
        }
    });
}
