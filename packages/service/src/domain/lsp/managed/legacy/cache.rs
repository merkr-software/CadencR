//! Discovery is coalesced for 30 seconds, while an explicit marketplace refresh invalidates it.
use super::{AppError, ServerProbe};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const TTL: Duration = Duration::from_secs(30);
struct Entry {
    refreshed: Instant,
    servers: Vec<ServerProbe>,
}
#[derive(Default)]
pub(super) struct DiscoveryCache(Mutex<HashMap<PathBuf, Entry>>);

impl DiscoveryCache {
    pub async fn get(
        &self,
        root: &Path,
        discover: impl Future<Output = Result<Vec<ServerProbe>, AppError>>,
    ) -> Result<Vec<ServerProbe>, AppError> {
        let mut entries = self.0.lock().await;
        if let Some(entry) = entries
            .get(root)
            .filter(|entry| entry.refreshed.elapsed() < TTL)
        {
            return Ok(entry.servers.clone());
        }
        let servers = discover.await?;
        entries.insert(
            root.to_owned(),
            Entry {
                refreshed: Instant::now(),
                servers: servers.clone(),
            },
        );
        Ok(servers)
    }
    pub async fn invalidate(&self) {
        self.0.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    async fn discover(path: &Path, runs: &AtomicUsize) -> Result<Vec<ServerProbe>, AppError> {
        runs.fetch_add(1, Ordering::SeqCst);
        if !path.is_file() {
            return Ok(vec![]);
        }
        Ok(vec![ServerProbe {
            lsp_id: "external".into(),
            name: "External".into(),
            description: String::new(),
            bin_name: "external".into(),
            args: vec!["--stdio".into()],
            language_ids: vec![],
            languages: vec![],
            root_markers: vec![],
            role: crate::domain::lsp::catalog::ServerRole::General,
            status: crate::domain::lsp::probe::ServerProbeStatus::OnPath,
            path: Some(path.to_string_lossy().into_owned()),
            version: None,
            downloadable: false,
            initialization_options: serde_json::json!({}),
            error: None,
        }])
    }

    #[tokio::test]
    async fn external_changes_are_discovered_after_invalidation_or_expiry() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("external");
        let cache = DiscoveryCache::default();
        let runs = AtomicUsize::new(0);
        let root = temp.path();
        assert!(cache
            .get(root, discover(&path, &runs))
            .await
            .unwrap()
            .is_empty());
        std::fs::write(&path, "installed").unwrap();
        assert!(cache
            .get(root, discover(&path, &runs))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        cache.invalidate().await;
        assert_eq!(
            cache.get(root, discover(&path, &runs)).await.unwrap().len(),
            1
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            cache.get(root, discover(&path, &runs)).await.unwrap().len(),
            1
        );
        cache.0.lock().await.get_mut(root).unwrap().refreshed = Instant::now() - TTL;
        assert!(cache
            .get(root, discover(&path, &runs))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(runs.load(Ordering::SeqCst), 3);
    }
}
