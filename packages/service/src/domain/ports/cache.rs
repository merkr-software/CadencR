use std::future::Future;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use super::models::FeaturePorts;
use super::service::{PORT_SCAN_TIMEOUT, PORT_SCAN_TOOL_MISSING};
use crate::error::AppError;
use crate::shared::singleflight::Singleflight;

/// A full scan shells out to `lsof`, so repeat it no more often than the
/// sidebar could usefully act on. Kept below the client's poll interval: this
/// exists to collapse *concurrent* pollers (the desktop app and any remote
/// client) onto one sweep, not to serve a single client stale data.
const CACHE_TTL: Duration = Duration::from_secs(5);

/// Backoff after a scan that timed out (e.g. a wedged NFS/FUSE mount) or
/// cannot run at all (no `lsof`). Keeps concurrent and immediate follow-up
/// polls from hammering `lsof` in a serial timeout cascade while still
/// recovering automatically. Other failures (a busy database, a transient
/// process-table read) are not cached: the next poll scans again.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(10);

type ScanOutcome = Result<Vec<FeaturePorts>, AppError>;

struct CachedEntry {
    /// A scan's data ages from when the scan started; a failure's backoff
    /// from when the scan gave up, so a slow timeout still gets its full wait.
    since: Instant,
    outcome: ScanOutcome,
}

/// The last machine-wide port scan, shared by every connected client via
/// singleflight coalescing and short negative backoff on scan failures.
pub struct PortScanCache {
    cached: Mutex<Option<CachedEntry>>,
    in_flight: Singleflight<(), ScanOutcome>,
    cache_ttl: Duration,
    negative_ttl: Duration,
}

impl Default for PortScanCache {
    fn default() -> Self {
        Self::with_ttls(CACHE_TTL, NEGATIVE_CACHE_TTL)
    }
}

/// Failures worth backing off from: repeating the scan right away would only
/// hit the same wall.
fn backs_off(error: &AppError) -> bool {
    matches!(
        error,
        AppError::Coded { code, .. } if *code == PORT_SCAN_TIMEOUT || *code == PORT_SCAN_TOOL_MISSING
    )
}

impl PortScanCache {
    fn with_ttls(cache_ttl: Duration, negative_ttl: Duration) -> Self {
        Self {
            cached: Mutex::new(None),
            in_flight: Singleflight::new(),
            cache_ttl,
            negative_ttl,
        }
    }

    fn fresh_hit(&self) -> Option<ScanOutcome> {
        let guard = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = guard.as_ref()?;
        let ttl = match &entry.outcome {
            Ok(_) => self.cache_ttl,
            Err(_) => self.negative_ttl,
        };
        (entry.since.elapsed() < ttl).then(|| entry.outcome.clone())
    }

    fn store(&self, started_at: Instant, outcome: &ScanOutcome) {
        let since = match outcome {
            Ok(_) => Some(started_at),
            Err(error) if backs_off(error) => Some(Instant::now()),
            Err(_) => None,
        };
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        *cached = since.map(|since| CachedEntry {
            since,
            outcome: outcome.clone(),
        });
    }

    /// Serve the last scan while it is fresh (or within negative backoff on
    /// error), otherwise run `scan` under singleflight coordination so
    /// concurrent pollers share one in-flight scan for both success and error.
    pub async fn get_or_refresh<F, Fut>(&self, mut scan: F) -> ScanOutcome
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = ScanOutcome>,
    {
        if let Some(outcome) = self.fresh_hit() {
            return outcome;
        }
        self.in_flight
            .run((), || {
                let hit = self.fresh_hit();
                let fut = hit.is_none().then(&mut scan);
                async move {
                    if let Some(outcome) = hit {
                        return outcome;
                    }
                    let started_at = Instant::now();
                    let outcome = fut.expect("scan future created on cache miss").await;
                    self.store(started_at, &outcome);
                    outcome
                }
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn timeout() -> AppError {
        AppError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            PORT_SCAN_TIMEOUT,
            "lsof timed out",
        )
    }

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
                            Err(timeout())
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

        let failed = cache.get_or_refresh(|| async { Err(timeout()) }).await;
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

    #[tokio::test]
    async fn a_transient_failure_is_not_served_to_the_next_poll() {
        let cache = PortScanCache::default();
        let busy = cache
            .get_or_refresh(|| async { Err(AppError::database_busy("locked")) })
            .await;
        assert!(matches!(busy, Err(AppError::DatabaseBusy(_))));
        let internal = cache
            .get_or_refresh(|| async { Err(AppError::internal("proc read failed")) })
            .await;
        assert!(matches!(internal, Err(AppError::Internal(_))));

        let recovered = cache
            .get_or_refresh(|| async { Ok(ports(3)) })
            .await
            .unwrap();
        assert_eq!(recovered, ports(3));
    }

    #[tokio::test]
    async fn fresh_data_ages_from_the_start_of_its_scan() {
        let cache = PortScanCache::with_ttls(Duration::from_millis(120), Duration::from_secs(10));
        let scanned = cache
            .get_or_refresh(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok(ports(4))
            })
            .await
            .unwrap();
        assert_eq!(scanned, ports(4));
        tokio::time::sleep(Duration::from_millis(40)).await;
        let rescanned = cache
            .get_or_refresh(|| async { Ok(ports(5)) })
            .await
            .unwrap();
        assert_eq!(rescanned, ports(5), "data is as old as its scan's start");
    }

    #[tokio::test]
    async fn a_timeout_backs_off_from_when_the_scan_gave_up() {
        let cache = PortScanCache::with_ttls(Duration::from_secs(5), Duration::from_millis(120));
        let failed = cache
            .get_or_refresh(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Err(timeout())
            })
            .await;
        assert!(failed.is_err());
        tokio::time::sleep(Duration::from_millis(40)).await;
        let backing_off = cache.get_or_refresh(|| async { Ok(ports(4)) }).await;
        assert!(backing_off.is_err(), "the backoff must run its full length");
    }
}
