//! Cancellation-safe singleflight coalescer keyed by `K`.
//!
//! Concurrent callers requesting the same key share one leader execution: if
//! the leader succeeds or fails, every waiter receives a clone of its outcome;
//! if the leader is cancelled or panics before publishing, its drop guard
//! clears the slot so a waiter retries cleanly without deadlocking.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::Mutex;

use crate::shared::discard::IgnoreClosed;
use tokio::sync::watch;

pub struct Singleflight<K, V> {
    slots: Mutex<HashMap<K, watch::Receiver<Option<V>>>>,
}

impl<K, V> Default for Singleflight<K, V> {
    fn default() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }
}

enum SlotRole<V> {
    Leader(watch::Sender<Option<V>>),
    Waiter(watch::Receiver<Option<V>>),
}

struct LeaderGuard<'a, K: Eq + Hash + Clone, V> {
    owner: &'a Singleflight<K, V>,
    key: K,
    tx: Option<watch::Sender<Option<V>>>,
}

impl<K: Eq + Hash + Clone, V> LeaderGuard<'_, K, V> {
    fn complete(mut self, value: V) {
        {
            let mut slots = self.owner.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.remove(&self.key);
        }
        if let Some(tx) = self.tx.take() {
            tx.send(Some(value)).ignore_closed();
        }
    }
}

impl<K: Eq + Hash + Clone, V> Drop for LeaderGuard<'_, K, V> {
    fn drop(&mut self) {
        if self.tx.take().is_some() {
            let mut slots = self.owner.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.remove(&self.key);
        }
    }
}

impl<K, V> Singleflight<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    pub fn new() -> Self {
        Self::default()
    }

    /// If a flight for `key` is currently running, wait for it and return its
    /// outcome. Returns `None` if no flight is active or the leader dropped
    /// before publishing.
    pub async fn wait_if_running(&self, key: &K) -> Option<V> {
        let rx = {
            let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.get(key).cloned()
        }?;
        wait_slot(rx).await
    }

    /// Join an existing flight for `key` or become the leader running `work`.
    /// If the leader is cancelled before producing a result, waiting callers
    /// loop and elect a new leader.
    pub async fn run<F, Fut>(&self, key: K, mut work: F) -> V
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = V>,
    {
        loop {
            let role = {
                let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(rx) = slots.get(&key) {
                    SlotRole::Waiter(rx.clone())
                } else {
                    let (tx, rx) = watch::channel(None);
                    slots.insert(key.clone(), rx);
                    SlotRole::Leader(tx)
                }
            };

            match role {
                SlotRole::Waiter(rx) => {
                    if let Some(value) = wait_slot(rx).await {
                        return value;
                    }
                }
                SlotRole::Leader(tx) => {
                    let guard = LeaderGuard {
                        owner: self,
                        key: key.clone(),
                        tx: Some(tx),
                    };
                    let value = work().await;
                    guard.complete(value.clone());
                    return value;
                }
            }
        }
    }
}

async fn wait_slot<V: Clone>(mut rx: watch::Receiver<Option<V>>) -> Option<V> {
    loop {
        if let Some(value) = rx.borrow_and_update().clone() {
            return Some(value);
        }
        if rx.changed().await.is_err() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn coalesces_concurrent_callers_into_one_leader() {
        let sf = Arc::new(Singleflight::<&str, usize>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());

        let sf1 = Arc::clone(&sf);
        let calls1 = Arc::clone(&calls);
        let started1 = Arc::clone(&started);
        let release1 = Arc::clone(&release);
        let leader = tokio::spawn(async move {
            sf1.run("k", || {
                let calls = Arc::clone(&calls1);
                let started = Arc::clone(&started1);
                let release = Arc::clone(&release1);
                async move {
                    let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    started.notify_one();
                    release.notified().await;
                    n
                }
            })
            .await
        });

        started.notified().await;

        let mut waiters = Vec::new();
        for _ in 0..4 {
            let sf_w = Arc::clone(&sf);
            let calls_w = Arc::clone(&calls);
            waiters.push(tokio::spawn(async move {
                sf_w.run("k", || {
                    let calls = Arc::clone(&calls_w);
                    async move { calls.fetch_add(1, Ordering::SeqCst) + 1 }
                })
                .await
            }));
        }
        tokio::task::yield_now().await;
        release.notify_one();

        assert_eq!(leader.await.unwrap(), 1);
        for waiter in waiters {
            assert_eq!(waiter.await.unwrap(), 1);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn cancelled_leader_unblocks_waiter_to_retry() {
        let sf = Arc::new(Singleflight::<&str, usize>::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());

        let sf1 = Arc::clone(&sf);
        let calls1 = Arc::clone(&calls);
        let started1 = Arc::clone(&started);
        let leader = tokio::spawn(async move {
            sf1.run("k", || {
                let calls = Arc::clone(&calls1);
                let started = Arc::clone(&started1);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    std::future::pending::<usize>().await
                }
            })
            .await
        });

        started.notified().await;
        let sf2 = Arc::clone(&sf);
        let calls2 = Arc::clone(&calls);
        let waiter = tokio::spawn(async move {
            sf2.run("k", || {
                let calls = Arc::clone(&calls2);
                async move { calls.fetch_add(1, Ordering::SeqCst) + 1 }
            })
            .await
        });
        tokio::task::yield_now().await;

        leader.abort();
        let _ = leader.await;

        assert_eq!(waiter.await.unwrap(), 2);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
