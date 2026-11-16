//! TTL-cached snapshot of `opencode models --verbose`.
//!
//! The retry and last-known-catalog policy is the shared
//! `domain::agents::catalog_cache` one; this module adds the context-window
//! table probed alongside the catalog and the spawn-path read.
//!
//! The probe seam is intentional: the production path uses
//! `super::probe::run`, but inline tests inject a closure via
//! `live_catalog_entry_with` without actually spawning a subprocess.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use opencode_sdk_rs::ConfigProvidersResponse;

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::catalog_cache::{CachedCatalog, CatalogProvider, LiveCatalogCache};
use crate::domain::agents::runtime::ProviderCatalogEntry;

/// The catalog plus a `model id → context window` table.
pub(super) type CatalogCacheEntry = CachedCatalog<HashMap<String, u64>>;

static CATALOG_CACHE: LazyLock<LiveCatalogCache<(), HashMap<String, u64>>> = LazyLock::new(|| {
    LiveCatalogCache::new(CatalogProvider {
        id: super::PROVIDER_ID,
        label: super::PROVIDER_LABEL,
        name: super::PROVIDER_LABEL,
    })
});

/// Production entry points use the real subprocess probe.
pub(super) async fn live_catalog() -> Arc<ProviderCatalogEntry> {
    live_catalog_entry().await.catalog
}

pub(super) async fn live_catalog_entry() -> CatalogCacheEntry {
    live_catalog_entry_with(super::probe::run).await
}

/// Probe seam. Tests inject a closure that returns `Ok`/`Err`
/// deterministically without spawning a subprocess.
pub(super) async fn live_catalog_entry_with<F, Fut>(probe: F) -> CatalogCacheEntry
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<ConfigProvidersResponse, RuntimeError>>,
{
    CATALOG_CACHE
        .get_with(&(), || {
            let response = probe();
            async move { response.await.map(super::catalog_from_response) }
        })
        .await
}

/// Spawn-path read. Model context windows rarely change, so serve whatever is
/// cached — refreshing a stale entry in the background — instead of blocking
/// the first prompt on a fresh `opencode models` probe (~0.7 s). Only an empty
/// cache waits for the probe.
pub(super) async fn cached_catalog_entry() -> CatalogCacheEntry {
    cached_catalog_entry_with(live_catalog_entry, || {
        tokio::spawn(live_catalog_entry());
    })
    .await
}

async fn cached_catalog_entry_with<L, LFut>(
    load: L,
    refresh_in_background: impl FnOnce(),
) -> CatalogCacheEntry
where
    L: FnOnce() -> LFut,
    LFut: Future<Output = CatalogCacheEntry>,
{
    match CATALOG_CACHE.cached(&()).await {
        Some(entry) => {
            if !entry.is_fresh() {
                refresh_in_background();
            }
            entry
        }
        None => load().await,
    }
}

#[cfg(test)]
pub(super) async fn reset_for_test() {
    CATALOG_CACHE.reset_for_test().await;
}

#[cfg(test)]
pub(super) async fn force_expire_for_test() {
    CATALOG_CACHE.force_expire_for_test(&()).await;
}

/// Shared serializer for tests across this module *and* `super::tests`.
/// Both touch the same process-global cache, so they must run one at a
/// time even though they live in different `cfg(test)` mods.
#[cfg(test)]
pub(super) static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::runtime::ProviderStatus;

    fn sample_response() -> ConfigProvidersResponse {
        serde_json::from_value(serde_json::json!({
            "providers": [
                {
                    "id": "anthropic",
                    "name": "Anthropic",
                    "models": {
                        "claude-sonnet-4-5": {
                            "name": "Claude Sonnet 4.5",
                            "limit": { "context": 200000, "output": 64000 }
                        }
                    }
                }
            ],
            "default": { "anthropic": "claude-sonnet-4-5" }
        }))
        .expect("fixture parses")
    }

    #[tokio::test]
    async fn spawn_path_serves_a_stale_entry_and_refreshes_in_background() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let _ = live_catalog_entry_with(|| async { Ok(sample_response()) }).await;
        force_expire_for_test().await;

        let mut refreshed = false;
        let entry = cached_catalog_entry_with(
            || async { panic!("a cached entry must not block on a probe") },
            || refreshed = true,
        )
        .await;

        assert!(refreshed, "a stale entry schedules a refresh");
        assert_eq!(
            entry.extra.get("anthropic/claude-sonnet-4-5"),
            Some(&200_000)
        );
        reset_for_test().await;
    }

    #[tokio::test]
    async fn spawn_path_waits_for_the_probe_on_an_empty_cache() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let entry = cached_catalog_entry_with(
            || live_catalog_entry_with(|| async { Ok(sample_response()) }),
            || panic!("nothing cached to refresh"),
        )
        .await;
        assert!(entry.extra.contains_key("anthropic/claude-sonnet-4-5"));
        reset_for_test().await;
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_last_known_models_and_context_windows() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let _ = live_catalog_entry_with(|| async { Ok(sample_response()) }).await;
        force_expire_for_test().await;

        let entry = live_catalog_entry_with(|| async {
            Err(RuntimeError::new("unterminated opencode models JSON block"))
        })
        .await;
        assert_eq!(entry.catalog.status, ProviderStatus::Available);
        assert_eq!(entry.catalog.id, "opencode");
        assert!(entry.extra.contains_key("anthropic/claude-sonnet-4-5"));
        assert_eq!(
            entry.catalog.refresh_error.as_deref(),
            Some("unterminated opencode models JSON block")
        );
        reset_for_test().await;
    }
}
