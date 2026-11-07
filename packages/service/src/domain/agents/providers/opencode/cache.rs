//! TTL-cached snapshot of opencode's `/config/providers` response.
//!
//! Mirrors the Codex `live_catalog` pattern at
//! `domain/agents/codex/mod.rs:131`. A failed refresh keeps serving the last
//! catalog the probe returned (the failure is logged) and retries after a
//! short window that doubles with each consecutive failure up to the TTL, so
//! a transient failure neither hides the provider nor respawns `opencode` on
//! every read. With nothing known yet (a cold cache) the probe is retried once
//! at once before the provider is reported unavailable. A missing CLI is
//! treated as an unavailable provider, not a warning-worthy failure.
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
use crate::domain::agents::runtime::{ProviderCatalogEntry, ProviderStatus};

const CATALOG_TTL: Duration = Duration::from_secs(30);
/// A failure slower than this (a hung CLI reaching its timeout) is not
/// retried at once: that would double the wait of every catalog reader.
const QUICK_FAILURE: Duration = Duration::from_secs(5);
/// How long a first failed refresh waits before probing again; it doubles
/// with each consecutive failure, up to `CATALOG_TTL`.
const FAILURE_RETRY: Duration = Duration::from_secs(5);

/// The cached snapshot. Both `catalog` and `context_windows` are
/// `Arc`-wrapped so every cache read is two refcount bumps — the
/// catalog itself is non-trivial (one `ModelCatalogEntry` per
/// upstream model, each with several `String` fields), and the
/// trait boundary already pays one clone, so paying a second one
/// inside the cache layer would double the cost for nothing.
#[derive(Clone)]
pub(super) struct CatalogCacheEntry {
    pub(super) fetched_at: Instant,
    /// `CATALOG_TTL` after a successful probe, the retry backoff after a failed one.
    ttl: Duration,
    /// Consecutive failed refreshes behind this entry.
    failures: u32,
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
        if entry.is_fresh() {
            return entry;
        }
    }

    let _guard = catalog_refresh_lock().lock().await;
    if let Some(entry) = catalog_cache().read().await.clone() {
        if entry.is_fresh() {
            return entry;
        }
    }

    let previous = catalog_cache().read().await.clone();
    let entry = match probe_with_retry(&probe, previous.as_ref()).await {
        Ok(response) => entry_from_response(response),
        Err(error @ RuntimeError::CliNotFound { .. }) => {
            unavailable_entry(cli_not_found_message(&error).unwrap_or_else(|| error.to_string()))
        }
        Err(error) => failed_refresh_entry(previous, &error),
    };

    *catalog_cache().write().await = Some(entry.clone());
    entry
}

/// The probe, retried once right away when nothing would stand in for it (no
/// known catalog, no failure already backing off) and it failed quickly. A
/// missing CLI is not retried.
async fn probe_with_retry<F, Fut>(
    probe: &F,
    previous: Option<&CatalogCacheEntry>,
) -> Result<ConfigProvidersResponse, RuntimeError>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<ConfigProvidersResponse, RuntimeError>>,
{
    let cold = !matches!(previous, Some(entry)
        if entry.failures > 0 || entry.catalog.status == ProviderStatus::Available);
    let started = Instant::now();
    match probe().await {
        Err(error)
            if cold
                && started.elapsed() < QUICK_FAILURE
                && !matches!(error, RuntimeError::CliNotFound { .. }) =>
        {
            tracing::warn!(provider = "opencode", error = %error, "live catalog probe failed; retrying");
            probe().await
        }
        result => result,
    }
}

/// Keep serving the last catalog the probe returned, retrying after the
/// backoff; without one, the provider is unavailable until that retry.
fn failed_refresh_entry(
    previous: Option<CatalogCacheEntry>,
    error: &RuntimeError,
) -> CatalogCacheEntry {
    let failures = previous.as_ref().map_or(0, |entry| entry.failures) + 1;
    let ttl = FAILURE_RETRY
        .saturating_mul(1 << (failures - 1).min(8))
        .min(CATALOG_TTL);
    let last_known = previous.filter(|entry| entry.catalog.status == ProviderStatus::Available);
    let Some(last_known) = last_known else {
        tracing::warn!(
            provider = "opencode",
            error = %error,
            "live catalog probe failed; marking provider unavailable until the retry",
        );
        let mut entry = unavailable_entry(format!("OpenCode unavailable: {error}"));
        entry.ttl = ttl;
        entry.failures = failures;
        return entry;
    };
    tracing::warn!(
        provider = "opencode",
        error = %error,
        "live catalog probe failed; keeping the last known catalog until the retry",
    );
    let catalog = ProviderCatalogEntry {
        status_message: Some(format!(
            "Showing the last known OpenCode models; refreshing them failed: {error}"
        )),
        ..(*last_known.catalog).clone()
    };
    CatalogCacheEntry {
        fetched_at: Instant::now(),
        ttl,
        failures,
        catalog: Arc::new(catalog),
        ..last_known
    }
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
            if !entry.is_fresh() {
                refresh_in_background();
            }
            entry
        }
        None => load().await,
    }
}

impl CatalogCacheEntry {
    fn is_fresh(&self) -> bool {
        self.fetched_at.elapsed() < self.ttl
    }
}

fn entry_from_response(response: ConfigProvidersResponse) -> CatalogCacheEntry {
    let (catalog, context_windows) = super::catalog_from_response(response);
    CatalogCacheEntry {
        fetched_at: Instant::now(),
        ttl: CATALOG_TTL,
        failures: 0,
        catalog: Arc::new(catalog),
        context_windows: Arc::new(context_windows),
    }
}

fn unavailable_entry(message: impl Into<String>) -> CatalogCacheEntry {
    CatalogCacheEntry {
        fetched_at: Instant::now(),
        ttl: CATALOG_TTL,
        failures: 0,
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
        entry.fetched_at = Instant::now() - entry.ttl - Duration::from_secs(1);
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

        let first = live_catalog_entry_with(&probe).await;
        assert_eq!(first.catalog.id, "opencode");
        assert_eq!(first.catalog.status, ProviderStatus::Unavailable);
        assert_eq!(first.catalog.default_model, None);
        assert!(first.catalog.models.is_empty());
        assert_eq!(first.ttl, FAILURE_RETRY);
        // The probe was retried once right away.
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // Subsequent call within the retry window must not re-spawn the probe.
        let _ = live_catalog_entry_with(&probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        // A failure that persists backs off: one probe per refresh, each
        // waiting twice as long, up to the regular TTL.
        for expected in [
            FAILURE_RETRY * 2,
            FAILURE_RETRY * 4,
            CATALOG_TTL,
            CATALOG_TTL,
        ] {
            force_expire_for_test().await;
            let before = calls.load(Ordering::SeqCst);
            let entry = live_catalog_entry_with(&probe).await;
            assert_eq!(calls.load(Ordering::SeqCst), before + 1);
            assert_eq!(entry.ttl, expected);
        }
        reset_for_test().await;
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_at_once() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let calls = AtomicUsize::new(0);
        let probe = || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if call == 0 {
                    Err(RuntimeError::new("unterminated opencode models JSON block"))
                } else {
                    Ok(sample_response())
                }
            }
        };
        let entry = live_catalog_entry_with(&probe).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(entry.catalog.status, ProviderStatus::Available);
        assert_eq!(entry.ttl, CATALOG_TTL);
        reset_for_test().await;
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_last_known_catalog() {
        let _guard = TEST_LOCK.lock().await;
        reset_for_test().await;
        let _ = live_catalog_entry_with(|| async { Ok(sample_response()) }).await;
        force_expire_for_test().await;

        let calls = AtomicUsize::new(0);
        let failing = || {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(RuntimeError::new("unterminated opencode models JSON block")) }
        };
        let entry = live_catalog_entry_with(&failing).await;
        // The known catalog stands in, so the probe is not retried at once.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(entry.catalog.status, ProviderStatus::Available);
        assert!(entry
            .context_windows
            .contains_key("anthropic/claude-sonnet-4-5"));
        assert_eq!(entry.ttl, FAILURE_RETRY, "a failed refresh retries soon");
        assert!(entry
            .catalog
            .status_message
            .as_deref()
            .is_some_and(|message| message.contains("unterminated opencode models JSON block")));

        // Once the retry window passes, the next read probes again and a
        // recovered probe restores the regular TTL.
        force_expire_for_test().await;
        let recovered = live_catalog_entry_with(|| async { Ok(sample_response()) }).await;
        assert_eq!(recovered.ttl, CATALOG_TTL);
        assert_eq!(recovered.failures, 0);
        assert_eq!(recovered.catalog.status_message, None);
        reset_for_test().await;
    }
}
