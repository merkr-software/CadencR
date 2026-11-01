//! Short-lived per-workspace cache of provider subprocess output (`models`,
//! `slash-commands`): at most [`MAX_CACHED_WORKSPACES`] entries (the oldest
//! goes first), one refresh per key at a time, and a refresh that raced an
//! invalidation returns its value without storing it.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use super::keyed_locks::KeyedLocks;

pub(super) const MAX_CACHED_WORKSPACES: usize = 16;

struct Entry<V> {
    /// Store order, for eviction: `Instant`s of quick stores can tie.
    order: u64,
    stored_at: Instant,
    ttl: Duration,
    value: V,
}

pub(super) struct WorkspaceCache<K, V> {
    entries: RwLock<HashMap<K, Entry<V>>>,
    refreshes: KeyedLocks<K>,
    generation: AtomicU64,
    stores: AtomicU64,
}

impl<K, V> Default for WorkspaceCache<K, V> {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            refreshes: KeyedLocks::default(),
            generation: AtomicU64::new(0),
            stores: AtomicU64::new(0),
        }
    }
}

impl<K: Eq + Hash + Clone, V: Clone> WorkspaceCache<K, V> {
    /// The fresh value for `key`, else the result of `refresh`. An `Ok`
    /// result is kept for the duration it returns; an `Err` is not kept.
    /// Callers waiting on the same key reuse the first caller's value.
    pub(super) async fn get_or_refresh<E, F, Fut>(&self, key: &K, refresh: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(V, Duration), E>>,
    {
        if let Some(value) = self.fresh(key).await {
            return Ok(value);
        }
        let lock = self.refreshes.lock_for(key).await;
        let _refresh = lock.lock().await;
        if let Some(value) = self.fresh(key).await {
            return Ok(value);
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let (value, ttl) = refresh().await?;
        self.store(key, value.clone(), ttl, generation).await;
        Ok(value)
    }

    pub(super) async fn fresh(&self, key: &K) -> Option<V> {
        self.entries
            .read()
            .await
            .get(key)
            .filter(|entry| entry.stored_at.elapsed() < entry.ttl)
            .map(|entry| entry.value.clone())
    }

    /// Forget `key`; a refresh already running for any key won't store.
    pub(super) async fn remove(&self, key: &K) {
        let mut entries = self.entries.write().await;
        self.generation.fetch_add(1, Ordering::SeqCst);
        entries.remove(key);
    }

    /// Forget every entry; a refresh already running won't store.
    pub(super) async fn clear(&self) {
        let mut entries = self.entries.write().await;
        self.generation.fetch_add(1, Ordering::SeqCst);
        entries.clear();
    }

    async fn store(&self, key: &K, value: V, ttl: Duration, generation: u64) {
        let mut entries = self.entries.write().await;
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if entries.len() >= MAX_CACHED_WORKSPACES && !entries.contains_key(key) {
            let oldest = entries
                .iter()
                .min_by_key(|(_, entry)| entry.order)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        let order = self.stores.fetch_add(1, Ordering::SeqCst);
        let stored_at = Instant::now();
        entries.insert(
            key.clone(),
            Entry {
                order,
                stored_at,
                ttl,
                value,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceCache, MAX_CACHED_WORKSPACES};
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const TTL: Duration = Duration::from_secs(30);

    async fn get(cache: &WorkspaceCache<u32, u32>, key: u32, value: u32) -> u32 {
        cache
            .get_or_refresh(&key, || async { Ok::<_, Infallible>((value, TTL)) })
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_refresh_and_errors_are_not_kept() {
        let cache = Arc::new(WorkspaceCache::<u32, u32>::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let tasks = (0..4).map(|_| {
            let (cache, runs) = (Arc::clone(&cache), Arc::clone(&runs));
            tokio::spawn(async move {
                cache
                    .get_or_refresh(&1, || async {
                        runs.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok::<_, Infallible>((7, TTL))
                    })
                    .await
                    .unwrap()
            })
        });
        for task in tasks {
            assert_eq!(task.await.unwrap(), 7);
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        let failed = cache
            .get_or_refresh(&2, || async { Err::<(u32, Duration), _>("down") })
            .await;
        assert_eq!(failed, Err("down"));
        assert_eq!(cache.fresh(&2).await, None);
    }

    #[tokio::test]
    async fn a_refresh_that_raced_an_invalidation_is_not_stored() {
        let cache = Arc::new(WorkspaceCache::<u32, u32>::default());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let refresh = tokio::spawn({
            let cache = Arc::clone(&cache);
            async move {
                cache
                    .get_or_refresh(&1, || async move {
                        started_tx.send(()).unwrap();
                        release_rx.await.unwrap();
                        Ok::<_, Infallible>((1, TTL))
                    })
                    .await
                    .unwrap()
            }
        });
        started_rx.await.unwrap();
        cache.remove(&1).await;
        release_tx.send(()).unwrap();
        assert_eq!(refresh.await.unwrap(), 1, "the caller still gets its value");
        assert_eq!(cache.fresh(&1).await, None);
        assert_eq!(get(&cache, 1, 2).await, 2);
    }

    #[tokio::test]
    async fn the_oldest_workspace_is_evicted() {
        let cache = WorkspaceCache::<u32, u32>::default();
        for key in 0..=MAX_CACHED_WORKSPACES as u32 {
            get(&cache, key, key).await;
        }
        assert_eq!(cache.fresh(&0).await, None);
        assert_eq!(cache.fresh(&1).await, Some(1));
        cache.clear().await;
        assert_eq!(cache.fresh(&1).await, None);
    }
}
