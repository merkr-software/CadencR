//! Codex model catalogs, probed through a throwaway `codex app-server`
//! (`config/read` + `model/list`) and cached under the shared retry and
//! last-known-catalog policy (`domain::agents::catalog_cache`), so a transient
//! app-server failure keeps the provider and its models in the picker. Once
//! the app-server has returned a catalog for a key (profile × directory), a
//! read does not wait for it: an expired catalog is served while a background
//! probe refreshes it, unless it expired too long ago.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use codex_app_server_sdk_rs::CodexModel;
use serde_json::Value;

use super::profile_runtime::{self, catalog_with_effective_config};
use super::{PROVIDER_ID, PROVIDER_LABEL};
use crate::domain::agents::adapter::{ResolvedRuntimeProfile, RuntimeError};
use crate::domain::agents::catalog_cache::{CachedCatalog, CatalogProvider, LiveCatalogCache};
use crate::domain::agents::runtime::ProviderCatalogEntry;

/// Where a catalog read without a workspace is probed: the service's own
/// directory (settings pages, the default model, the startup warm-up).
pub(super) const NO_WORKSPACE: &str = ".";

/// A resolved profile in a directory, whose effective config shapes the catalog.
#[derive(Clone, PartialEq, Eq, Hash)]
struct CatalogKey {
    identity: String,
    revision: String,
    cwd: PathBuf,
}

impl CatalogKey {
    fn new(profile: &ResolvedRuntimeProfile, cwd: &Path) -> Self {
        Self {
            identity: profile.identity.clone(),
            revision: profile.revision.clone(),
            cwd: cwd.to_path_buf(),
        }
    }
}

/// What the probe behind a catalog read: the models and the `config/read`
/// response. Resolving the effective configuration falls back on it when the
/// app-server cannot be probed (see `profile_runtime::resolved_effective_config`).
/// Empty when no probe returned a catalog for the key.
#[derive(Default)]
pub(super) struct CodexProbe {
    pub(super) models: Vec<CodexModel>,
    pub(super) config: Value,
}

static CATALOG_CACHE: LazyLock<LiveCatalogCache<CatalogKey, CodexProbe>> = LazyLock::new(|| {
    LiveCatalogCache::new(CatalogProvider {
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        name: "Codex",
    })
});

/// The catalog read without a workspace, for the active profile: the entry
/// the settings pages read, so warming it up at startup is not wasted.
pub(super) async fn live_catalog() -> ProviderCatalogEntry {
    profile_runtime::catalog_for_profile(None, None).await
}

/// The catalog of `profile` in `cwd` (none: [`NO_WORKSPACE`]).
pub(super) async fn profile_catalog(
    profile: &ResolvedRuntimeProfile,
    cwd: Option<&Path>,
) -> ProviderCatalogEntry {
    (*probed(profile, cwd).await.catalog).clone()
}

/// The last probe that returned `profile`'s catalog in `cwd`, however old,
/// without probing: what the picker shows while the app-server is down.
pub(super) async fn last_known_probe(
    profile: &ResolvedRuntimeProfile,
    cwd: &Path,
) -> Option<Arc<CodexProbe>> {
    CATALOG_CACHE
        .cached(&CatalogKey::new(profile, cwd))
        .await
        .map(|entry| entry.extra)
        .filter(|probe| !probe.models.is_empty())
}

async fn probed(profile: &ResolvedRuntimeProfile, cwd: Option<&Path>) -> CachedCatalog<CodexProbe> {
    let cwd = cwd.unwrap_or(Path::new(NO_WORKSPACE)).to_path_buf();
    let key = CatalogKey::new(profile, &cwd);
    let profile = profile.clone();
    cached_probe(key, move || {
        let (profile, cwd) = (profile.clone(), cwd.clone());
        async move {
            let (models, config) =
                profile_runtime::probe_models_and_config(Some(&profile), &cwd).await?;
            let models = non_empty(models)?;
            let catalog = catalog_with_effective_config(models.clone(), &config);
            Ok((catalog, CodexProbe { models, config }))
        }
    })
    .await
}

async fn cached_probe<F, Fut>(key: CatalogKey, probe: F) -> CachedCatalog<CodexProbe>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(ProviderCatalogEntry, CodexProbe), RuntimeError>> + Send + 'static,
{
    LazyLock::force(&CATALOG_CACHE)
        .get_or_revalidate(key, probe)
        .await
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
    use crate::domain::agents::codex::catalog_from_models;
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

    /// The native default profile under an identity no other test shares:
    /// the cache is process-global.
    fn test_profile(name: &str) -> ResolvedRuntimeProfile {
        let mut profile = profile_runtime::resolve_profile_for_selection(Some("default"))
            .expect("the default profile resolves without a CLI");
        profile.identity = format!("test-{name}");
        profile
    }

    fn unique_key(name: &str) -> CatalogKey {
        CatalogKey::new(
            &test_profile(name),
            Path::new(&format!("/nonexistent/{name}")),
        )
    }

    fn known(
        model_id: &'static str,
    ) -> impl Fn() -> std::future::Ready<Result<ProviderCatalogEntry, RuntimeError>> {
        move || std::future::ready(Ok(catalog_from_models(vec![model(model_id)])))
    }

    /// A catalog-only probe through the cache (no models or config kept).
    async fn cached_catalog<F, Fut>(key: CatalogKey, probe: F) -> ProviderCatalogEntry
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<ProviderCatalogEntry, RuntimeError>> + Send + 'static,
    {
        let entry = cached_probe(key, move || {
            let catalog = probe();
            async move {
                catalog
                    .await
                    .map(|catalog| (catalog, CodexProbe::default()))
            }
        })
        .await;
        (*entry.catalog).clone()
    }

    /// Seed `cwd`'s entry for `profile` with a probe that read `config`.
    async fn seed_probe(profile: &ResolvedRuntimeProfile, cwd: &Path, config: Value) {
        cached_probe(CatalogKey::new(profile, cwd), move || {
            let models = vec![model("gpt-known")];
            let config = config.clone();
            async move {
                let catalog = catalog_with_effective_config(models.clone(), &config);
                Ok((catalog, CodexProbe { models, config }))
            }
        })
        .await;
    }

    #[tokio::test]
    async fn the_last_known_probe_keeps_the_config_the_catalog_was_read_with() {
        let profile = test_profile("effective-config");
        let cwd = Path::new("/nonexistent/effective-config");
        let config = serde_json::json!({ "config": { "model": "gpt-configured" } });
        seed_probe(&profile, cwd, config.clone()).await;
        // Expired entries still answer: this read never probes.
        CATALOG_CACHE
            .force_expire_for_test(&CatalogKey::new(&profile, cwd))
            .await;

        let probe = last_known_probe(&profile, cwd)
            .await
            .expect("a probe is cached");
        assert_eq!(probe.config, config);
        assert_eq!(probe.models[0].id, "gpt-known");
    }

    #[tokio::test]
    async fn without_a_known_catalog_there_is_no_last_known_probe() {
        let profile = test_profile("no-probe");
        let cwd = Path::new("/nonexistent/no-probe");
        let _ = cached_catalog(CatalogKey::new(&profile, cwd), || async {
            Err(RuntimeError::new("app-server stdout closed"))
        })
        .await;

        assert!(last_known_probe(&profile, cwd).await.is_none());
    }

    #[tokio::test]
    async fn a_failed_model_list_keeps_the_last_known_codex_models() {
        let key = unique_key("last-known");
        let first = cached_catalog(key.clone(), known("gpt-known")).await;
        assert_eq!(first.status, ProviderStatus::Available);
        assert_eq!(first.refresh_error, None);

        CATALOG_CACHE.force_expire_for_test(&key).await;
        let failing = || async { Err(RuntimeError::new("Codex model/list timed out")) };
        // The expired catalog is served at once; the refresh runs behind it.
        let stale = cached_catalog(key.clone(), failing).await;
        assert_eq!(stale.default_model.as_deref(), Some("gpt-known"));
        assert_eq!(stale.refresh_error, None);

        let mut served = None;
        for _ in 0..200 {
            served = CATALOG_CACHE
                .cached(&key)
                .await
                .filter(|entry| entry.catalog.refresh_error.is_some());
            if served.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let served = served.expect("the background refresh recorded its failure");
        assert_eq!(served.catalog.status, ProviderStatus::Available);
        assert_eq!(served.catalog.default_model.as_deref(), Some("gpt-known"));
        assert_eq!(served.catalog.models.len(), 1);
        assert_eq!(
            served.catalog.refresh_error.as_deref(),
            Some("Codex model/list timed out")
        );
    }

    #[tokio::test]
    async fn an_empty_model_list_on_a_cold_cache_is_unavailable() {
        let key = unique_key("empty");
        let catalog = cached_catalog(key, || async {
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

    #[tokio::test]
    async fn a_read_without_a_workspace_lands_on_the_no_workspace_entry() {
        // The warm-up and the settings pages both read with no cwd; that read
        // lands on the `NO_WORKSPACE` entry, so a fresh one is served without
        // starting an app-server.
        let profile = test_profile("no-workspace");
        let warmed = cached_catalog(
            CatalogKey::new(&profile, Path::new(NO_WORKSPACE)),
            known("gpt-warmed"),
        )
        .await;
        assert_eq!(warmed.default_model.as_deref(), Some("gpt-warmed"));

        let read = profile_catalog(&profile, None).await;
        assert_eq!(read.status, ProviderStatus::Available);
        assert_eq!(read.default_model.as_deref(), Some("gpt-warmed"));
    }
}
