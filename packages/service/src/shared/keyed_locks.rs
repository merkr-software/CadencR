//! One async lock per key, so concurrent refreshes of the same cache entry
//! run one provider subprocess instead of several.
//! Entries are weak: a key's lock lives only while someone holds or awaits it.
//! The lock is a `Mutex` by default; any `Default` lock fits (an `RwLock` for
//! readers that may share it).

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Weak};

use tokio::sync::Mutex;

#[derive(Debug)]
pub(crate) struct KeyedLocks<K, L = Mutex<()>> {
    locks: Mutex<HashMap<K, Weak<L>>>,
}

impl<K, L> Default for KeyedLocks<K, L> {
    fn default() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone, L: Default> KeyedLocks<K, L> {
    pub(crate) async fn lock_for(&self, key: &K) -> Arc<L> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(L::default());
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
        let locks: KeyedLocks<String> = KeyedLocks::default();
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
