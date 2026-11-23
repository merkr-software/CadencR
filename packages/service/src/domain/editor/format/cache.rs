//! Per-formatter resolved binary cache with TTL and immediate invalidation.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use super::super::format_catalog::FormatterEntry;
use crate::error::AppError;
use crate::shared::singleflight::Singleflight;

/// Positive formatter binary cache TTL; invalidated immediately on `NotFound`.
const POSITIVE_CACHE_TTL: Duration = Duration::from_secs(300);
/// Short negative cache TTL so installing a formatter works without restart.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(15);

struct CachedBinary {
    path: Option<PathBuf>,
    expires_at: Instant,
}

#[derive(Default)]
pub(super) struct FormatterBinaryCache {
    entries: RwLock<HashMap<String, CachedBinary>>,
    inflight: Singleflight<String, Result<Option<PathBuf>, AppError>>,
}

impl FormatterBinaryCache {
    pub(super) async fn get(&self, id: &str, now: Instant) -> Option<Option<PathBuf>> {
        let guard = self.entries.read().await;
        let entry = guard.get(id)?;
        (entry.expires_at > now).then(|| entry.path.clone())
    }

    pub(super) async fn insert(&self, id: &str, path: Option<PathBuf>, now: Instant) {
        let ttl = if path.is_some() {
            POSITIVE_CACHE_TTL
        } else {
            NEGATIVE_CACHE_TTL
        };
        let mut guard = self.entries.write().await;
        guard.insert(
            id.to_string(),
            CachedBinary {
                path,
                expires_at: now + ttl,
            },
        );
    }

    pub(super) async fn invalidate(&self, id: &str) {
        let mut guard = self.entries.write().await;
        guard.remove(id);
    }

    pub(super) async fn resolve_with<F, Fut>(
        &self,
        entry: &FormatterEntry,
        mut discover: F,
    ) -> Result<PathBuf, AppError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<PathBuf>, AppError>>,
    {
        if let Some(cached) = self.get(entry.id, Instant::now()).await {
            return cached.ok_or_else(|| formatter_not_found(entry, None));
        }
        let discovered = self
            .inflight
            .run(entry.id.to_string(), || {
                let probe = discover();
                async move {
                    if let Some(cached) = self.get(entry.id, Instant::now()).await {
                        return Ok(cached);
                    }
                    // A failed search is not a missing binary: report it and
                    // cache nothing, so the next request searches again.
                    let discovered = probe.await?;
                    self.insert(entry.id, discovered.clone(), Instant::now())
                        .await;
                    Ok(discovered)
                }
            })
            .await?;
        discovered.ok_or_else(|| formatter_not_found(entry, None))
    }
}

pub(super) fn global_cache() -> &'static FormatterBinaryCache {
    static CACHE: OnceLock<FormatterBinaryCache> = OnceLock::new();
    CACHE.get_or_init(FormatterBinaryCache::default)
}

/// The formatter's binary is not installed, or (`gone`) no longer where it
/// was found.
pub(super) fn formatter_not_found(entry: &FormatterEntry, gone: Option<String>) -> AppError {
    let bin = entry.bin_name;
    let found = match gone {
        Some(detail) => format!("formatter {bin:?} is gone ({detail})"),
        None => format!("formatter {bin:?} not found"),
    };
    AppError::coded(
        axum::http::StatusCode::NOT_FOUND,
        "FORMATTER_NOT_FOUND",
        format!(
            "{found}; install it on $PATH to enable {} formatting",
            entry.id
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::editor::format_catalog;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn negative_cache_avoids_repeated_discovery_until_invalidated() {
        let cache = FormatterBinaryCache::default();
        let entry = format_catalog::lookup("biome").expect("biome entry");
        let calls = Arc::new(AtomicUsize::new(0));

        for _ in 0..2 {
            let calls_ref = calls.clone();
            let err = cache
                .resolve_with(entry, move || {
                    let calls_ref = calls_ref.clone();
                    async move {
                        calls_ref.fetch_add(1, Ordering::SeqCst);
                        Ok(None)
                    }
                })
                .await
                .unwrap_err();
            assert!(matches!(
                err,
                AppError::Coded {
                    code: "FORMATTER_NOT_FOUND",
                    ..
                }
            ));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "missing binary should be negatively cached"
        );

        cache.invalidate(entry.id).await;
        let calls_ref = calls.clone();
        let resolved = cache
            .resolve_with(entry, move || {
                let calls_ref = calls_ref.clone();
                async move {
                    calls_ref.fetch_add(1, Ordering::SeqCst);
                    Ok(Some(PathBuf::from("/bin/cat")))
                }
            })
            .await
            .unwrap();
        assert_eq!(resolved, PathBuf::from("/bin/cat"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_cold_lookups_coalesce_into_one_discovery() {
        let cache = Arc::new(FormatterBinaryCache::default());
        let entry = format_catalog::lookup("prettier").expect("prettier entry");
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let leader = {
            let cache = Arc::clone(&cache);
            let calls = Arc::clone(&calls);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            tokio::spawn(async move {
                cache
                    .resolve_with(entry, move || {
                        let calls = Arc::clone(&calls);
                        let started = Arc::clone(&started);
                        let release = Arc::clone(&release);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            started.notify_one();
                            release.notified().await;
                            Ok(Some(PathBuf::from("/bin/cat")))
                        }
                    })
                    .await
            })
        };

        started.notified().await;

        let mut waiters = Vec::new();
        for _ in 0..4 {
            let cache = Arc::clone(&cache);
            let calls = Arc::clone(&calls);
            waiters.push(tokio::spawn(async move {
                cache
                    .resolve_with(entry, move || {
                        let calls = Arc::clone(&calls);
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(Some(PathBuf::from("/bin/cat")))
                        }
                    })
                    .await
            }));
        }

        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        release.notify_one();

        assert_eq!(leader.await.unwrap().unwrap(), PathBuf::from("/bin/cat"));
        for waiter in waiters {
            assert_eq!(waiter.await.unwrap().unwrap(), PathBuf::from("/bin/cat"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// A search that failed (its blocking task panicked) is reported, not
    /// cached as "formatter not found" for the negative TTL.
    #[tokio::test]
    async fn a_failed_search_is_reported_and_not_cached() {
        let cache = FormatterBinaryCache::default();
        let entry = format_catalog::lookup("biome").expect("biome entry");
        let err = cache
            .resolve_with(entry, || async {
                Err(AppError::coded(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "FORMATTER_DISCOVERY_FAILED",
                    "search task panicked",
                ))
            })
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            AppError::Coded {
                code: "FORMATTER_DISCOVERY_FAILED",
                ..
            }
        ));
        assert!(cache.get(entry.id, Instant::now()).await.is_none());
        let resolved = cache
            .resolve_with(entry, || async { Ok(Some(PathBuf::from("/bin/cat"))) })
            .await
            .unwrap();
        assert_eq!(resolved, PathBuf::from("/bin/cat"));
    }
}
