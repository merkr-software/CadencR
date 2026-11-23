//! Short-lived per-workspace cache of provider `slash-commands` subprocess
//! output: at most [`MAX_CACHED_WORKSPACES`] entries (the oldest goes first),
//! one refresh per key at a time, and a refresh that raced an invalidation
//! returns its value without storing it.

use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::shared::keyed_locks::KeyedLocks;

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
    /// Keys with a background stale-while-revalidate refresh in flight.
    revalidating: std::sync::Mutex<HashSet<K>>,
}

impl<K, V> Default for WorkspaceCache<K, V> {
    fn default() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            refreshes: KeyedLocks::default(),
            generation: AtomicU64::new(0),
            stores: AtomicU64::new(0),
            revalidating: std::sync::Mutex::new(HashSet::new()),
        }
    }
}

impl<K, V> WorkspaceCache<K, V> {
    fn revalidating_keys(&self) -> std::sync::MutexGuard<'_, HashSet<K>> {
        self.revalidating
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl<K: Eq + Hash + Clone, V: Clone> WorkspaceCache<K, V> {
    /// The fresh value for `key`, else the result of `refresh`. An `Ok`
    /// result is kept for the duration it returns; an `Err` is not kept.
    /// Callers waiting on the same key reuse the first caller's value.
    #[cfg(test)]
    pub(super) async fn get_or_refresh<E, F, Fut>(&self, key: &K, refresh: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(V, Duration), E>>,
    {
        if let Some(value) = self.fresh(key).await {
            return Ok(value);
        }
        self.refresh_locked(key, refresh).await
    }

    async fn refresh_locked<E, F, Fut>(&self, key: &K, refresh: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(V, Duration), E>>,
    {
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

    pub(super) async fn fresh<Q>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.entries
            .read()
            .await
            .get(key)
            .filter(|entry| entry.stored_at.elapsed() < entry.ttl)
            .map(|entry| entry.value.clone())
    }

    #[cfg(test)]
    pub(super) async fn force_expire_for_test(&self, key: &K) {
        if let Some(entry) = self.entries.write().await.get_mut(key) {
            entry.stored_at = Instant::now() - entry.ttl - Duration::from_secs(1);
        }
    }

    async fn lookup(
        &self,
        key: &K,
        max_stale: Duration,
        is_servable: impl FnOnce(&V) -> bool,
    ) -> Lookup<V> {
        let entries = self.entries.read().await;
        let Some(entry) = entries.get(key) else {
            return Lookup::Miss;
        };
        let age = entry.stored_at.elapsed();
        if age < entry.ttl {
            Lookup::Fresh(entry.value.clone())
        } else if age < entry.ttl + max_stale && is_servable(&entry.value) {
            Lookup::Stale(entry.value.clone())
        } else {
            Lookup::Miss
        }
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

enum Lookup<V> {
    Fresh(V),
    Stale(V),
    Miss,
}

impl<K, V> WorkspaceCache<K, V>
where
    K: Eq + Hash + Clone + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    /// Stale-while-revalidate read for an `Arc`-owned cache. Serves a fresh
    /// entry at once, serves an expired entry passing `is_servable` within
    /// `max_stale` while starting at most one background refresh, and waits on
    /// `refresh` otherwise.
    pub(super) async fn get_or_revalidate<E, F, Fut>(
        self: &Arc<Self>,
        key: &K,
        max_stale: Duration,
        is_servable: impl FnOnce(&V) -> bool,
        refresh: F,
    ) -> Result<V, E>
    where
        E: std::fmt::Display + Send + 'static,
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<(V, Duration), E>> + Send + 'static,
    {
        match self.lookup(key, max_stale, is_servable).await {
            Lookup::Fresh(value) => Ok(value),
            Lookup::Stale(stale) => {
                if self.revalidating_keys().insert(key.clone()) {
                    let guard = RevalidationGuard {
                        cache: Arc::clone(self),
                        key: key.clone(),
                    };
                    tokio::spawn(async move {
                        if let Err(error) = guard.cache.refresh_locked(&guard.key, refresh).await {
                            tracing::debug!(%error, "background workspace cache revalidation failed");
                        }
                        drop(guard);
                    });
                }
                Ok(stale)
            }
            Lookup::Miss => self.refresh_locked(key, refresh).await,
        }
    }
}

struct RevalidationGuard<K: Eq + Hash + Clone, V> {
    cache: Arc<WorkspaceCache<K, V>>,
    key: K,
}

impl<K: Eq + Hash + Clone, V> Drop for RevalidationGuard<K, V> {
    fn drop(&mut self) {
        self.cache.revalidating_keys().remove(&self.key);
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

    #[tokio::test]
    async fn get_or_revalidate_serves_stale_immediately_and_refreshes_once_in_background() {
        let cache = Arc::new(WorkspaceCache::<u32, u32>::default());
        assert_eq!(get(&cache, 1, 10).await, 10);
        cache.force_expire_for_test(&1).await;

        let runs = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();

        let first = cache
            .get_or_revalidate(&1, Duration::from_secs(60), |_| true, {
                let runs = Arc::clone(&runs);
                move || async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    let _ = started_tx.send(());
                    let _ = release_rx.await;
                    Ok::<_, Infallible>((20, TTL))
                }
            })
            .await
            .unwrap();
        assert_eq!(
            first, 10,
            "expired entry must return stale value immediately"
        );
        started_rx.await.unwrap();

        // Second caller while revalidation is in flight also gets stale without spawning another refresh.
        let second = cache
            .get_or_revalidate(&1, Duration::from_secs(60), |_| true, {
                let runs = Arc::clone(&runs);
                move || async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Ok::<_, Infallible>((30, TTL))
                }
            })
            .await
            .unwrap();
        assert_eq!(second, 10);
        assert_eq!(runs.load(Ordering::SeqCst), 1);

        let _ = release_tx.send(());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if cache.fresh(&1).await == Some(20) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("background refresh should populate the fresh value");
    }
}
