//! Provider-neutral TTL cache of live model catalogs.
//!
//! A successful probe is served for [`CATALOG_TTL`]. A failed refresh keeps
//! serving the last catalog a probe returned, with `refresh_error` saying why,
//! and retries after a short window that doubles with each consecutive failure
//! up to the TTL, so a transient failure neither hides the provider nor
//! respawns its CLI on every read. With nothing known yet (a cold entry) a
//! quick failure is retried once at once before the provider is reported
//! unavailable. A missing CLI is an unavailable provider, not retried before
//! the TTL.
//!
//! Unlike `providers::installed::workspace_cache` (same keyed single-flight
//! and eviction, but a failed refresh keeps nothing), every outcome here is an
//! entry: the policy needs the previous one to decide the next.
//!
//! Each provider owns its cache and its probe; the probe is a parameter so
//! tests inject a counting closure instead of spawning a CLI.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use super::adapter::RuntimeError;
use super::discovery::cli_not_found_message;
use super::runtime::{ProviderCatalogEntry, ProviderStatus};
use crate::shared::keyed_locks::KeyedLocks;

const CATALOG_TTL: Duration = Duration::from_secs(30);
/// A failure slower than this (a hung CLI reaching its timeout) is not
/// retried at once: that would double the wait of every catalog reader.
const QUICK_FAILURE: Duration = Duration::from_secs(5);
/// How long a first failed refresh waits before probing again; it doubles
/// with each consecutive failure, up to `CATALOG_TTL`.
const FAILURE_RETRY: Duration = Duration::from_secs(5);
/// Keys a cache keeps (workspaces × profiles); the oldest entry goes first.
const MAX_CACHED_KEYS: usize = 16;

/// The provider a cache serves, for the entries it builds without a probe.
pub(crate) struct CatalogProvider {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    /// How failure messages name the provider ("OpenCode", "Codex").
    pub(crate) name: &'static str,
}

/// One cached catalog, plus provider data probed alongside it (`X`). Both are
/// `Arc`-wrapped so a cache read is two refcount bumps.
pub(crate) struct CachedCatalog<X> {
    fetched_at: Instant,
    /// `CATALOG_TTL` after a successful probe, the retry backoff after a failed one.
    ttl: Duration,
    /// Consecutive failed refreshes behind this entry.
    failures: u32,
    pub(crate) catalog: Arc<ProviderCatalogEntry>,
    pub(crate) extra: Arc<X>,
}

// Not derived: that would require `X: Clone` for what are refcount bumps.
impl<X> Clone for CachedCatalog<X> {
    fn clone(&self) -> Self {
        Self {
            catalog: Arc::clone(&self.catalog),
            extra: Arc::clone(&self.extra),
            ..*self
        }
    }
}

impl<X> CachedCatalog<X> {
    pub(crate) fn is_fresh(&self) -> bool {
        self.fetched_at.elapsed() < self.ttl
    }

    /// Whether a probe ever returned this catalog (fresh or last known).
    fn is_known(&self) -> bool {
        self.catalog.status == ProviderStatus::Available
    }
}

pub(crate) struct LiveCatalogCache<K, X> {
    provider: CatalogProvider,
    /// Each entry with its store order, for eviction: `Instant`s of quick
    /// stores can tie.
    entries: RwLock<HashMap<K, (u64, CachedCatalog<X>)>>,
    refreshes: KeyedLocks<K>,
    stores: AtomicU64,
}

impl<K: Eq + Hash + Clone, X: Default> LiveCatalogCache<K, X> {
    pub(crate) fn new(provider: CatalogProvider) -> Self {
        Self {
            provider,
            entries: RwLock::new(HashMap::new()),
            refreshes: KeyedLocks::default(),
            stores: AtomicU64::new(0),
        }
    }

    /// Whatever is cached for `key`, fresh or not.
    pub(crate) async fn cached(&self, key: &K) -> Option<CachedCatalog<X>> {
        self.entries
            .read()
            .await
            .get(key)
            .map(|(_, entry)| entry.clone())
    }

    /// The fresh entry for `key`, else the outcome of `probe` under the
    /// policy above. Callers waiting on the same key share one probe.
    pub(crate) async fn get_with<F, Fut>(&self, key: &K, probe: F) -> CachedCatalog<X>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<(ProviderCatalogEntry, X), RuntimeError>>,
    {
        if let Some(entry) = self.cached(key).await.filter(CachedCatalog::is_fresh) {
            return entry;
        }
        let lock = self.refreshes.lock_for(key).await;
        let _refresh = lock.lock().await;
        let previous = self.cached(key).await;
        if let Some(entry) = previous.as_ref().filter(|entry| entry.is_fresh()) {
            return entry.clone();
        }

        let entry = match self.probe_with_retry(&probe, previous.as_ref()).await {
            Ok((catalog, extra)) => CachedCatalog {
                fetched_at: Instant::now(),
                ttl: CATALOG_TTL,
                failures: 0,
                catalog: Arc::new(catalog),
                extra: Arc::new(extra),
            },
            Err(error @ RuntimeError::CliNotFound { .. }) => self.unavailable(
                cli_not_found_message(&error).unwrap_or_else(|| error.to_string()),
                CATALOG_TTL,
                0,
            ),
            Err(error) => self.failed_refresh(previous, &error),
        };
        self.store(key, entry.clone()).await;
        entry
    }

    /// The probe, retried once right away when nothing would stand in for it
    /// (no known catalog, no failure already backing off) and it failed
    /// quickly. A missing CLI is not retried.
    async fn probe_with_retry<F, Fut>(
        &self,
        probe: &F,
        previous: Option<&CachedCatalog<X>>,
    ) -> Result<(ProviderCatalogEntry, X), RuntimeError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<(ProviderCatalogEntry, X), RuntimeError>>,
    {
        let cold = !previous.is_some_and(|entry| entry.failures > 0 || entry.is_known());
        let started = Instant::now();
        match probe().await {
            Err(error)
                if cold
                    && started.elapsed() < QUICK_FAILURE
                    && !matches!(error, RuntimeError::CliNotFound { .. }) =>
            {
                tracing::warn!(
                    provider = self.provider.id,
                    error = %error,
                    "live catalog probe failed; retrying",
                );
                probe().await
            }
            result => result,
        }
    }

    /// Keep serving the last catalog a probe returned, retrying after the
    /// backoff; without one, the provider is unavailable until that retry.
    fn failed_refresh(
        &self,
        previous: Option<CachedCatalog<X>>,
        error: &RuntimeError,
    ) -> CachedCatalog<X> {
        let failures = previous.as_ref().map_or(0, |entry| entry.failures) + 1;
        let ttl = FAILURE_RETRY
            .saturating_mul(1 << (failures - 1).min(8))
            .min(CATALOG_TTL);
        let Some(last_known) = previous.filter(CachedCatalog::is_known) else {
            tracing::warn!(
                provider = self.provider.id,
                error = %error,
                "live catalog probe failed; marking provider unavailable until the retry",
            );
            let message = format!("{} unavailable: {error}", self.provider.name);
            return self.unavailable(message, ttl, failures);
        };
        tracing::warn!(
            provider = self.provider.id,
            error = %error,
            "live catalog probe failed; keeping the last known catalog until the retry",
        );
        let catalog = ProviderCatalogEntry {
            refresh_error: Some(error.to_string()),
            ..(*last_known.catalog).clone()
        };
        CachedCatalog {
            fetched_at: Instant::now(),
            ttl,
            failures,
            catalog: Arc::new(catalog),
            ..last_known
        }
    }

    fn unavailable(&self, message: String, ttl: Duration, failures: u32) -> CachedCatalog<X> {
        CachedCatalog {
            fetched_at: Instant::now(),
            ttl,
            failures,
            catalog: Arc::new(ProviderCatalogEntry::unavailable(
                self.provider.id,
                self.provider.label,
                message,
            )),
            extra: Arc::new(X::default()),
        }
    }

    async fn store(&self, key: &K, entry: CachedCatalog<X>) {
        let mut entries = self.entries.write().await;
        if !entries.contains_key(key) && entries.len() >= MAX_CACHED_KEYS {
            let oldest = entries
                .iter()
                .min_by_key(|(_, (order, _))| *order)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        let order = self.stores.fetch_add(1, Ordering::Relaxed);
        entries.insert(key.clone(), (order, entry));
    }

    #[cfg(test)]
    pub(crate) async fn reset_for_test(&self) {
        self.entries.write().await.clear();
    }

    #[cfg(test)]
    pub(crate) async fn force_expire_for_test(&self, key: &K) {
        if let Some((_, entry)) = self.entries.write().await.get_mut(key) {
            entry.fetched_at = Instant::now() - entry.ttl - Duration::from_secs(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const PROVIDER: CatalogProvider = CatalogProvider {
        id: "test_provider",
        label: "Test Provider",
        name: "Test",
    };

    fn cache() -> LiveCatalogCache<(), u32> {
        LiveCatalogCache::new(PROVIDER)
    }

    fn sample() -> (ProviderCatalogEntry, u32) {
        let mut catalog = ProviderCatalogEntry::unavailable(PROVIDER.id, PROVIDER.label, "");
        catalog.status = ProviderStatus::Available;
        catalog.status_message = None;
        catalog.default_model = Some("model".to_string());
        (catalog, 7)
    }

    #[tokio::test]
    async fn serves_a_cached_entry_within_the_ttl_and_refreshes_after() {
        let cache = cache();
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(sample()) }
        };

        let first = cache.get_with(&(), &probe).await;
        let second = cache.get_with(&(), &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first.catalog.default_model, second.catalog.default_model);
        assert_eq!(*second.extra, 7);

        cache.force_expire_for_test(&()).await;
        let _ = cache.get_with(&(), &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn keys_are_cached_independently() {
        let cache: LiveCatalogCache<&str, u32> = LiveCatalogCache::new(PROVIDER);
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Ok(sample()) }
        };
        let _ = cache.get_with(&"a", &probe).await;
        let _ = cache.get_with(&"b", &probe).await;
        let _ = cache.get_with(&"a", &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_readers_of_a_key_share_one_probe() {
        let cache = cache();
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(sample())
            }
        };
        let entries = futures::future::join_all((0..4).map(|_| cache.get_with(&(), &probe))).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(entries
            .iter()
            .all(|entry| entry.catalog.status == ProviderStatus::Available));
    }

    #[tokio::test]
    async fn a_cold_failure_is_retried_once_then_backs_off() {
        let cache = cache();
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(RuntimeError::new("probe boom")) }
        };

        let first = cache.get_with(&(), &probe).await;
        assert_eq!(first.catalog.id, PROVIDER.id);
        assert_eq!(first.catalog.status, ProviderStatus::Unavailable);
        assert_eq!(
            first.catalog.status_message.as_deref(),
            Some("Test unavailable: probe boom")
        );
        assert_eq!(first.catalog.refresh_error, None);
        assert!(first.catalog.models.is_empty());
        assert_eq!(*first.extra, 0);
        assert_eq!(first.ttl, FAILURE_RETRY);
        // The probe was retried once right away.
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // Within the retry window the probe is not spawned again.
        let _ = cache.get_with(&(), &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A failure that persists backs off: one probe per refresh, each
        // waiting twice as long, up to the regular TTL.
        for expected in [
            FAILURE_RETRY * 2,
            FAILURE_RETRY * 4,
            CATALOG_TTL,
            CATALOG_TTL,
        ] {
            cache.force_expire_for_test(&()).await;
            let before = calls.load(Ordering::SeqCst);
            let entry = cache.get_with(&(), &probe).await;
            assert_eq!(calls.load(Ordering::SeqCst), before + 1);
            assert_eq!(entry.ttl, expected);
        }
    }

    #[tokio::test]
    async fn a_transient_cold_failure_is_retried_at_once() {
        let cache = cache();
        let calls = AtomicUsize::new(0);
        let probe = || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if call == 0 {
                    Err(RuntimeError::new("transient"))
                } else {
                    Ok(sample())
                }
            }
        };
        let entry = cache.get_with(&(), &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(entry.catalog.status, ProviderStatus::Available);
        assert_eq!(entry.ttl, CATALOG_TTL);
    }

    #[tokio::test]
    async fn a_missing_cli_is_unavailable_without_a_retry() {
        let cache = cache();
        let calls = AtomicUsize::new(0);
        let probe = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(RuntimeError::cli_not_found("test", vec![])) }
        };
        let entry = cache.get_with(&(), &probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(entry.catalog.status, ProviderStatus::Unavailable);
        assert_eq!(entry.ttl, CATALOG_TTL);
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_last_known_catalog() {
        let cache = cache();
        let _ = cache.get_with(&(), || async { Ok(sample()) }).await;
        cache.force_expire_for_test(&()).await;

        let calls = AtomicUsize::new(0);
        let failing = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(RuntimeError::new("model/list timed out")) }
        };
        let entry = cache.get_with(&(), &failing).await;
        // The known catalog stands in, so the probe is not retried at once.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(entry.catalog.status, ProviderStatus::Available);
        assert_eq!(entry.catalog.default_model.as_deref(), Some("model"));
        assert_eq!(*entry.extra, 7);
        assert_eq!(entry.ttl, FAILURE_RETRY, "a failed refresh retries soon");
        assert_eq!(
            entry.catalog.refresh_error.as_deref(),
            Some("model/list timed out")
        );
        assert_eq!(entry.catalog.status_message, None);

        // A second failure still serves the last known catalog, backing off.
        cache.force_expire_for_test(&()).await;
        let again = cache.get_with(&(), &failing).await;
        assert_eq!(again.catalog.status, ProviderStatus::Available);
        assert_eq!(again.ttl, FAILURE_RETRY * 2);

        // A recovered probe restores the regular TTL and clears the error.
        cache.force_expire_for_test(&()).await;
        let recovered = cache.get_with(&(), || async { Ok(sample()) }).await;
        assert_eq!(recovered.ttl, CATALOG_TTL);
        assert_eq!(recovered.failures, 0);
        assert_eq!(recovered.catalog.refresh_error, None);
    }

    #[tokio::test]
    async fn the_oldest_key_is_evicted_past_the_cap() {
        let cache: LiveCatalogCache<usize, u32> = LiveCatalogCache::new(PROVIDER);
        for key in 0..=MAX_CACHED_KEYS {
            let _ = cache.get_with(&key, || async { Ok(sample()) }).await;
        }
        assert!(cache.cached(&0).await.is_none());
        assert!(cache.cached(&MAX_CACHED_KEYS).await.is_some());
        assert_eq!(cache.entries.read().await.len(), MAX_CACHED_KEYS);
    }
}
