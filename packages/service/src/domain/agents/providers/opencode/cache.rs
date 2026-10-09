//! TTL-cached snapshot of opencode's `/config/providers` response.
//!
//! Mirrors the Codex `live_catalog` pattern at
//! `domain/agents/codex/mod.rs:131`. Probe failures are folded into the
//! cache for the TTL window so a flaky probe doesn't respawn
//! `opencode serve` on every FE refresh (`.claude/rules/error-handling.md`).
//! A missing CLI is treated as an unavailable provider, not a warning-worthy
//! failure.
//!
//! The probe seam is intentional: the production path uses
//! `super::probe::run`, but inline tests inject a counting closure via
//! `live_catalog_entry_with` to assert TTL + failure-caching behaviour
//! without actually spawning a subprocess.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use opencode_sdk_rs::ConfigProvidersResponse;
use tokio::sync::{Mutex, RwLock};

use crate::domain::agents::adapter::RuntimeError;
use crate::domain::agents::discovery::cli_not_found_message;
use crate::domain::agents::runtime::ProviderCatalogEntry;

const CATALOG_TTL: Duration = Duration::from_secs(30);

/// The cached snapshot. Both `catalog` and `context_windows` are
/// `Arc`-wrapped so every cache read is two refcount bumps — the
/// catalog itself is non-trivial (one `ModelCatalogEntry` per
/// upstream model, each with several `String` fields), and the
/// trait boundary already pays one clone, so paying a second one
/// inside the cache layer would double the cost for nothing.
#[derive(Clone)]
pub(super) struct CatalogCacheEntry {
    pub(super) fetched_at: Instant,
    pub(super) catalog: Arc<ProviderCatalogEntry>,
    pub(super) context_windows: Arc<HashMap<String, u64>>,
}

static CATALOG_CACHE: OnceLock<RwLock<Option<CatalogCacheEntry>>> = OnceLock::new();
static CATALOG_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn catalog_cache() -> &'static RwLock<Option<CatalogCacheEntry>> {
    CATALOG_CACHE.get_or_init(|| RwLock::new(None))
}

fn catalog_refresh_lock() -> &'static Mutex<()> {
    CATALOG_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

/// Production entry points use the real subprocess probe.
pub(super) async fn live_catalog() -> Arc<ProviderCatalogEntry> {
    live_catalog_entry().await.catalog
}

pub(super) async fn live_catalog_entry() -> CatalogCacheEntry {
    live_catalog_entry_with(super::probe::run).await
}

/// Probe seam. Tests inject a counting closure that returns `Ok`/`Err`
/// deterministically without spawning a subprocess.
pub(super) async fn live_catalog_entry_with<F, Fut>(probe: F) -> CatalogCacheEntry
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<ConfigProvidersResponse, RuntimeError>>,
{
    if let Some(entry) = catalog_cache().read().await.clone() {
        if entry.fetched_at.elapsed() < CATALOG_TTL {
            return entry;
        }
    }

    let _guard = catalog_refresh_lock().lock().await;
    if let Some(entry) = catalog_cache().read().await.clone() {
        if entry.fetched_at.elapsed() < CATALOG_TTL {
            return entry;
        }
    }

    let entry = match probe().await {
        Ok(response) => entry_from_response(response),
        Err(error @ RuntimeError::CliNotFound { .. }) => {
            unavailable_entry(cli_not_found_message(&error).unwrap_or_else(|| error.to_string()))
        }
        Err(error) => {
            tracing::warn!(
                provider = "opencode",
                error = %error,
                "live catalog probe failed; marking provider unavailable",
            );
            unavailable_entry(format!("OpenCode unavailable: {error}"))
        }
    };

    *catalog_cache().write().await = Some(entry.clone());
    entry
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
    let cached = catalog_cache().read().await.clone();
    match cached {
        Some(entry) => {
            if entry.fetched_at.elapsed() >= CATALOG_TTL {
                refresh_in_background();
            }
            entry
        }
        None => load().await,
    }
}

fn entry_from_response(response: ConfigProvidersResponse) -> CatalogCacheEntry {
    let (catalog, context_windows) = super::catalog_from_response(response);
    CatalogCacheEntry {
        fetched_at: Instant::now(),
        catalog: Arc::new(catalog),
        context_windows: Arc::new(context_windows),
    }
}

fn unavailable_entry(message: impl Into<String>) -> CatalogCacheEntry {
    CatalogCacheEntry {
        fetched_at: Instant::now(),
        catalog: Arc::new(ProviderCatalogEntry::unavailable(
            super::PROVIDER_ID,
            super::PROVIDER_LABEL,
            message,
        )),
        context_windows: Arc::new(HashMap::new()),
    }
}

#[cfg(test)]
pub(super) async fn reset_for_test() {
    *catalog_cache().write().await = None;
}

#[cfg(test)]
pub(super) async fn force_expire_for_test() {
    let mut guard = catalog_cache().write().await;
    if let Some(entry) = guard.as_mut() {
        entry.fetched_at = Instant::now() - CATALOG_TTL - Duration::from_secs(1);
    }
}

/// Shared serializer for tests across this module *and* `super::tests`.
/// Both touch the same process-global cache, so they must run one at a
/// time even though they live in different `cfg(test)` mods.
#[cfg(test)]
pub(super) static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
    async fn cache_returns_stale_entry_within_ttl() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(sample_response()) }
        };

        let first = live_catalog_entry_with(&probe).await;
        let second = live_catalog_entry_with(&probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.catalog.default_model, second.catalog.default_model);
        reset_for_test().await;
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
            entry.context_windows.get("anthropic/claude-sonnet-4-5"),
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
        assert!(entry
            .context_windows
            .contains_key("anthropic/claude-sonnet-4-5"));
        reset_for_test().await;
    }

    #[tokio::test]
    async fn cache_refreshes_after_ttl() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(sample_response()) }
        };

        let _ = live_catalog_entry_with(&probe).await;
        force_expire_for_test().await;
        let _ = live_catalog_entry_with(&probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        reset_for_test().await;
    }

    #[tokio::test]
    async fn probe_failure_marks_provider_unavailable() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(RuntimeError::new("probe boom")) }
        };

        let first = live_catalog_entry_with(&probe).await.catalog;
        assert_eq!(first.id, "opencode");
        assert_eq!(
            first.status,
            crate::domain::agents::runtime::ProviderStatus::Unavailable
        );
        assert_eq!(first.default_model, None);
        assert!(first.models.is_empty());

        // Subsequent call within TTL must not re-spawn the probe.
        let _ = live_catalog_entry_with(&probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        reset_for_test().await;
    }
}
