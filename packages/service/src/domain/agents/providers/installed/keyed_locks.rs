//! One async lock per key, so concurrent refreshes of the same cache entry
//! (a workspace directory) run one provider subprocess instead of several.
//! Entries are weak: a key's lock lives only while someone holds or awaits it.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Weak};

use tokio::sync::Mutex;

#[derive(Debug)]
pub(super) struct KeyedLocks<K> {
    locks: Mutex<HashMap<K, Weak<Mutex<()>>>>,
}

impl<K> Default for KeyedLocks<K> {
    fn default() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone> KeyedLocks<K> {
    pub(super) async fn lock_for(&self, key: &K) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key.clone(), Arc::downgrade(&lock));
        lock
    }
}

#[cfg(test)]
mod tests {
    use super::KeyedLocks;
    use std::sync::Arc;

    #[tokio::test]
    async fn the_same_key_shares_one_lock_while_it_is_held() {
        let locks = KeyedLocks::default();
        let first = locks.lock_for(&"a".to_string()).await;
        let again = locks.lock_for(&"a".to_string()).await;
        let other = locks.lock_for(&"b".to_string()).await;
        assert!(Arc::ptr_eq(&first, &again));
        assert!(!Arc::ptr_eq(&first, &other));
        drop((first, again));
        assert_eq!(locks.locks.lock().await.len(), 2);
        let _ = locks.lock_for(&"c".to_string()).await;
        assert!(!locks.locks.lock().await.contains_key("a"));
    }
}
