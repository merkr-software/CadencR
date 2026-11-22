use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::http::StatusCode;

use super::models::FeaturePorts;
use crate::error::AppError;
use crate::shared::singleflight::Singleflight;

/// A full scan shells out to `lsof`, so repeat it no more often than the
/// sidebar could usefully act on. Kept below the client's poll interval: this
/// exists to collapse *concurrent* pollers (the desktop app and any remote
/// client) onto one sweep, not to serve a single client stale data.
const CACHE_TTL: Duration = Duration::from_secs(5);

/// Backoff after a failed or timed-out scan (e.g. a wedged NFS/FUSE mount).
/// Keeps concurrent and immediate follow-up polls from hammering `lsof` in a
/// serial timeout cascade while still recovering automatically.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(10);

type SharedOutcome = Result<Vec<FeaturePorts>, CachedPortScanError>;

#[derive(Clone, Debug)]
enum CachedPortScanError {
    Coded {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    ServiceUnavailable(String),
    DatabaseBusy(String),
    Internal(String),
}

impl CachedPortScanError {
    fn from_app_error(error: AppError) -> Self {
        match error {
            AppError::Coded {
                status,
                code,
                message,
            } => Self::Coded {
                status,
                code,
                message,
            },
            AppError::ServiceUnavailable(message) => Self::ServiceUnavailable(message),
            AppError::DatabaseBusy(detail) => Self::DatabaseBusy(detail.to_string()),
            other => Self::Internal(other.to_string()),
        }
    }

    #[track_caller]
    fn into_app_error(self) -> AppError {
        match self {
            Self::Coded {
                status,
                code,
                message,
            } => AppError::Coded {
                status,
                code,
                message,
            },
            Self::ServiceUnavailable(message) => AppError::ServiceUnavailable(message),
            Self::DatabaseBusy(message) => {
                AppError::DatabaseBusy(crate::error::Detail::new(message))
            }
            Self::Internal(message) => AppError::internal(message),
        }
    }
}

struct CachedEntry {
    captured_at: Instant,
    outcome: SharedOutcome,
}

/// The last machine-wide port scan, shared by every connected client via
/// singleflight coalescing and short negative backoff on scan failures.
pub struct PortScanCache {
    cached: Mutex<Option<CachedEntry>>,
    in_flight: Singleflight<(), SharedOutcome>,
    cache_ttl: Duration,
    negative_ttl: Duration,
}

impl Default for PortScanCache {
    fn default() -> Self {
        Self {
            cached: Mutex::new(None),
            in_flight: Singleflight::new(),
            cache_ttl: CACHE_TTL,
            negative_ttl: NEGATIVE_CACHE_TTL,
        }
    }
}

impl PortScanCache {
    #[cfg(test)]
    fn with_ttls(cache_ttl: Duration, negative_ttl: Duration) -> Self {
        Self {
            cached: Mutex::new(None),
            in_flight: Singleflight::new(),
            cache_ttl,
            negative_ttl,
        }
    }

    fn fresh_hit(&self) -> Option<SharedOutcome> {
        let guard = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = guard.as_ref()?;
        let ttl = match &entry.outcome {
            Ok(_) => self.cache_ttl,
            Err(_) => self.negative_ttl,
        };
        (entry.captured_at.elapsed() < ttl).then(|| entry.outcome.clone())
    }

    /// Serve the last scan while it is fresh (or within negative backoff on
    /// error), otherwise run `scan` under singleflight coordination so
    /// concurrent pollers share one in-flight scan for both success and error.
    pub async fn get_or_refresh<F, Fut>(&self, mut scan: F) -> Result<Vec<FeaturePorts>, AppError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Vec<FeaturePorts>, AppError>>,
    {
        if let Some(outcome) = self.fresh_hit() {
            return outcome.map_err(CachedPortScanError::into_app_error);
        }
        let outcome = self
            .in_flight
            .run((), || {
                let hit = self.fresh_hit();
                let fut = hit.is_none().then(&mut scan);
                async move {
                    if let Some(outcome) = hit {
                        return outcome;
                    }
                    let outcome = fut
                        .expect("scan future created on cache miss")
                        .await
                        .map_err(CachedPortScanError::from_app_error);
                    let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
                    *cached = Some(CachedEntry {
                        captured_at: Instant::now(),
                        outcome: outcome.clone(),
                    });
                    outcome
                }
            })
            .await;
        outcome.map_err(CachedPortScanError::into_app_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn ports(feature_id: i64) -> Vec<FeaturePorts> {
        vec![FeaturePorts {
            feature_id,
            ports: Vec::new(),
        }]
    }

    #[tokio::test]
    async fn a_fresh_entry_is_served_without_rescanning() {
        let cache = PortScanCache::default();
        let scans = AtomicUsize::new(0);

        for _ in 0..3 {
            let result = cache
                .get_or_refresh(|| async {
                    scans.fetch_add(1, Ordering::SeqCst);
                    Ok(ports(7))
                })
                .await
                .unwrap();
            assert_eq!(result, ports(7));
        }

        assert_eq!(scans.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_callers_share_a_single_failing_scan_and_hit_negative_backoff() {
        let cache = Arc::new(PortScanCache::with_ttls(
            Duration::from_secs(5),
            Duration::from_secs(10),
        ));
        let scans = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        let mut handles = Vec::new();
        for _ in 0..5 {
            let cache = Arc::clone(&cache);
            let scans = Arc::clone(&scans);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            handles.push(tokio::spawn(async move {
                cache
                    .get_or_refresh(|| {
                        let scans = Arc::clone(&scans);
                        let started = Arc::clone(&started);
                        let release = Arc::clone(&release);
                        async move {
                            scans.fetch_add(1, Ordering::SeqCst);
                            started.notify_one();
                            release.notified().await;
                            Err(AppError::internal("lsof timed out"))
                        }
                    })
                    .await
            }));
        }

        // Wait for the single leader to enter `scan`, yield so all 4 peers join
        // as singleflight waiters, then fail the scan once.
        started.notified().await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        release.notify_waiters();

        for handle in handles {
            let result = handle.await.unwrap();
            assert!(
                result.is_err(),
                "all concurrent callers must observe the error"
            );
        }
        assert_eq!(
            scans.load(Ordering::SeqCst),
            1,
            "5 concurrent callers must invoke scan only once"
        );

        // Immediate follow-up hits negative backoff without invoking `scan`.
        let follow_up = cache
            .get_or_refresh(|| async {
                scans.fetch_add(1, Ordering::SeqCst);
                Ok(ports(9))
            })
            .await;
        assert!(follow_up.is_err());
        assert_eq!(
            scans.load(Ordering::SeqCst),
            1,
            "negative backoff must suppress immediate rescans"
        );
    }

    #[tokio::test]
    async fn a_failed_scan_recovers_after_negative_backoff_expires() {
        let cache = PortScanCache::with_ttls(Duration::from_secs(5), Duration::from_millis(30));

        let failed = cache
            .get_or_refresh(|| async { Err(AppError::internal("lsof exploded")) })
            .await;
        assert!(failed.is_err());

        tokio::time::sleep(Duration::from_millis(45)).await;

        let recovered = cache
            .get_or_refresh(|| async { Ok(ports(9)) })
            .await
            .unwrap();
        assert_eq!(recovered, ports(9));
    }

    #[tokio::test]
    async fn preserves_coded_missing_tool_error_for_waiters_and_backoff() {
        let cache = PortScanCache::with_ttls(Duration::from_secs(5), Duration::from_secs(10));
        let first = cache
            .get_or_refresh(|| async {
                Err(AppError::Coded {
                    status: StatusCode::SERVICE_UNAVAILABLE,
                    code: "PORT_SCAN_TOOL_MISSING",
                    message: "install lsof".into(),
                })
            })
            .await
            .unwrap_err();
        assert!(matches!(
            first,
            AppError::Coded {
                code: "PORT_SCAN_TOOL_MISSING",
                ..
            }
        ));

        let second = cache
            .get_or_refresh(|| async { Ok(ports(1)) })
            .await
            .unwrap_err();
        assert!(matches!(
            second,
            AppError::Coded {
                code: "PORT_SCAN_TOOL_MISSING",
                ..
            }
        ));
    }
}
