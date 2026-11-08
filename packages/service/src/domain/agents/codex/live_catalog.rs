//! Codex model catalogs, probed through a throwaway `codex app-server`
//! (`model/list`) and cached under the shared retry and last-known-catalog
//! policy (`domain::agents::catalog_cache`), so a transient app-server failure
//! keeps the provider and its models in the picker.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use codex_app_server_sdk_rs::CodexModel;

use super::profile_runtime::{self, catalog_with_effective_config};
use super::{catalog_from_models, PROVIDER_ID, PROVIDER_LABEL};
use crate::domain::agents::adapter::{ResolvedRuntimeProfile, RuntimeError};
use crate::domain::agents::catalog_cache::{CatalogProvider, LiveCatalogCache};
use crate::domain::agents::runtime::ProviderCatalogEntry;

#[derive(Clone, PartialEq, Eq, Hash)]
enum CatalogKey {
    /// The default Codex home outside any workspace (startup warm-up, default model).
    Shared,
    /// A resolved profile in a workspace, whose effective config shapes the catalog.
    Profile {
        identity: String,
        revision: String,
        cwd: PathBuf,
    },
}

static CATALOG_CACHE: LazyLock<LiveCatalogCache<CatalogKey, ()>> = LazyLock::new(|| {
    LiveCatalogCache::new(CatalogProvider {
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        name: "Codex",
    })
});

pub(super) async fn live_catalog() -> ProviderCatalogEntry {
    cached_catalog(&CatalogKey::Shared, || async {
        let models = profile_runtime::probe_models().await?;
        Ok(catalog_from_models(non_empty(models)?))
    })
    .await
}

pub(super) async fn profile_catalog(
    profile: &ResolvedRuntimeProfile,
    cwd: &Path,
) -> ProviderCatalogEntry {
    let key = CatalogKey::Profile {
        identity: profile.identity.clone(),
        revision: profile.revision.clone(),
        cwd: cwd.to_path_buf(),
    };
    cached_catalog(&key, || async {
        let (models, config) = profile_runtime::probe_models_and_config(Some(profile), cwd).await?;
        Ok(catalog_with_effective_config(non_empty(models)?, &config))
    })
    .await
}

async fn cached_catalog<F, Fut>(key: &CatalogKey, probe: F) -> ProviderCatalogEntry
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<ProviderCatalogEntry, RuntimeError>>,
{
    let entry = CATALOG_CACHE
        .get_with(key, || {
            let catalog = probe();
            async move { catalog.await.map(|catalog| (catalog, ())) }
        })
        .await;
    (*entry.catalog).clone()
}

/// An empty `model/list` is a failed refresh, not a catalog to keep.
fn non_empty(models: Vec<CodexModel>) -> Result<Vec<CodexModel>, RuntimeError> {
    if models.is_empty() {
        return Err(RuntimeError::new("codex app-server returned no models"));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::runtime::ProviderStatus;

    fn model(id: &str) -> CodexModel {
        CodexModel {
            id: id.to_string(),
            label: id.to_string(),
            description: None,
            supported_efforts: vec![],
            default_effort: None,
            service_tiers: vec![],
            context_window: None,
            is_default: true,
        }
    }

    /// A key no other test shares: the cache is process-global.
    fn unique_key(name: &str) -> CatalogKey {
        CatalogKey::Profile {
            identity: format!("test-{name}"),
            revision: "test".to_string(),
            cwd: PathBuf::from(format!("/nonexistent/{name}")),
        }
    }

    #[tokio::test]
    async fn a_failed_model_list_keeps_the_last_known_codex_models() {
        let key = unique_key("last-known");
        let first = cached_catalog(&key, || async {
            Ok(catalog_from_models(vec![model("gpt-known")]))
        })
        .await;
        assert_eq!(first.status, ProviderStatus::Available);
        assert_eq!(first.refresh_error, None);

        CATALOG_CACHE.force_expire_for_test(&key).await;
        let served = cached_catalog(&key, || async {
            Err(RuntimeError::new("Codex model/list timed out"))
        })
        .await;
        assert_eq!(served.status, ProviderStatus::Available);
        assert_eq!(served.default_model.as_deref(), Some("gpt-known"));
        assert_eq!(served.models.len(), 1);
        assert_eq!(
            served.refresh_error.as_deref(),
            Some("Codex model/list timed out")
        );
    }

    #[tokio::test]
    async fn an_empty_model_list_on_a_cold_cache_is_unavailable() {
        let key = unique_key("empty");
        let catalog = cached_catalog(&key, || async {
            Ok(catalog_from_models(non_empty(Vec::new())?))
        })
        .await;
        assert_eq!(catalog.id, PROVIDER_ID);
        assert_eq!(catalog.status, ProviderStatus::Unavailable);
        assert_eq!(
            catalog.status_message.as_deref(),
            Some("Codex unavailable: codex app-server returned no models")
        );
    }
}
