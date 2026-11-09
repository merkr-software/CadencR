use std::future::Future;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::models::FeaturePorts;
use crate::error::AppError;

/// A full scan shells out to `lsof` twice, so repeat it no more often than the
/// sidebar could usefully act on. Kept below the client's poll interval: this
/// exists to collapse *concurrent* pollers (the desktop app and any remote
/// client) onto one sweep, not to serve a single client stale data.
const CACHE_TTL: Duration = Duration::from_secs(5);

struct Entry {
    captured_at: Instant,
    ports: Vec<FeaturePorts>,
}

/// The last machine-wide port scan, shared by every connected client.
#[derive(Default)]
pub struct PortScanCache {
    entry: Mutex<Option<Entry>>,
}

impl PortScanCache {
    /// Serve the last scan while it is fresh, otherwise run `scan`. The lock is
    /// held across the scan so concurrent pollers coalesce onto one `lsof` run
    /// rather than stampeding it.
    pub async fn get_or_refresh<F, Fut>(&self, scan: F) -> Result<Vec<FeaturePorts>, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<FeaturePorts>, AppError>>,
    {
        let mut entry = self.entry.lock().await;
        if let Some(cached) = entry.as_ref() {
            if cached.captured_at.elapsed() < CACHE_TTL {
                return Ok(cached.ports.clone());
            }
        }
        let ports = scan().await?;
        *entry = Some(Entry {
            captured_at: Instant::now(),
            ports: ports.clone(),
        });
        Ok(ports)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
    async fn a_failed_scan_is_not_cached() {
        let cache = PortScanCache::default();

        let failed = cache
            .get_or_refresh(|| async { Err(AppError::internal("lsof exploded")) })
            .await;
        assert!(failed.is_err());

        let recovered = cache
            .get_or_refresh(|| async { Ok(ports(9)) })
            .await
            .unwrap();
        assert_eq!(recovered, ports(9));
    }
}
