//! Which custom tabs are open (`docs/CUSTOM_TABS.md` §4.7): a tab instance
//! with a native backend holds a lease, renewed by the desktop while the tab
//! is open — shown or hidden, used or idle — and released when it closes. A
//! backend outlives its tab's grants (an idle tab mints none) but not its
//! leases. In memory only: a restart forgets every lease along with every
//! backend.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::StatusCode;

use crate::error::AppError;

/// How long a lease lives unrenewed. The desktop renews it every minute; a
/// hidden window's timers may fire late, so this leaves room for two misses.
pub const LEASE_TTL: Duration = Duration::from_secs(3 * 60);
/// Leases held at once, across every tab.
pub const MAX_LEASES: usize = 1024;
pub const MAX_LEASE_ID_CHARS: usize = 64;

struct Lease {
    plugin_id: String,
    feature_id: i64,
    expires: Instant,
}

/// The open tab instances of this process. Cheap to clone.
#[derive(Clone, Default)]
pub struct PresenceStore {
    leases: Arc<Mutex<HashMap<String, Lease>>>,
}

impl PresenceStore {
    /// Take or renew lease `id`: `plugin_id` is open in `feature_id` for
    /// another [`LEASE_TTL`].
    pub fn renew(&self, id: &str, plugin_id: &str, feature_id: i64) -> Result<(), AppError> {
        check_lease_id(id)?;
        let now = Instant::now();
        let mut leases = self.lock();
        leases.retain(|_, lease| lease.expires > now);
        if !leases.contains_key(id) && leases.len() >= MAX_LEASES {
            return Err(AppError::coded(
                StatusCode::TOO_MANY_REQUESTS,
                "PLUGIN_TAB_PRESENCE_FULL",
                format!("at most {MAX_LEASES} custom tab instances may be open"),
            ));
        }
        leases.insert(
            id.to_string(),
            Lease {
                plugin_id: plugin_id.to_string(),
                feature_id,
                expires: now + LEASE_TTL,
            },
        );
        Ok(())
    }

    /// Release lease `id` (its tab closed). Releasing an unknown or another
    /// tab's lease is a no-op.
    pub fn release(&self, id: &str, plugin_id: &str) {
        let mut leases = self.lock();
        if leases
            .get(id)
            .is_some_and(|lease| lease.plugin_id == plugin_id)
        {
            leases.remove(id);
        }
    }

    /// Release every lease held in these conversations (deleted or
    /// archived), whichever tab and client took them.
    pub fn release_features(&self, feature_ids: &[i64]) {
        self.lock()
            .retain(|_, lease| !feature_ids.contains(&lease.feature_id));
    }

    /// Whether some instance of `plugin_id` holds a live lease in `feature_id`.
    pub fn is_open(&self, plugin_id: &str, feature_id: i64) -> bool {
        let now = Instant::now();
        self.lock().values().any(|lease| {
            lease.plugin_id == plugin_id && lease.feature_id == feature_id && lease.expires > now
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Lease>> {
        // Every operation is one retain/insert/remove: a panic leaves a
        // consistent map.
        self.leases
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) fn check_lease_id(id: &str) -> Result<(), AppError> {
    let valid = (1..=MAX_LEASE_ID_CHARS).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        return Ok(());
    }
    Err(AppError::BadRequest(format!(
        "a lease id is 1–{MAX_LEASE_ID_CHARS} letters, digits or `-`"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEASE: &str = "0b6f3a52-6c1e-4f1e-9a43-3f1f2e7d9c10";

    #[test]
    fn a_lease_keeps_its_tab_open_until_released() {
        let store = PresenceStore::default();
        assert!(!store.is_open("ports", 2));
        store.renew(LEASE, "ports", 2).unwrap();
        assert!(store.is_open("ports", 2));
        assert!(!store.is_open("ports", 3));
        assert!(!store.is_open("other", 2));
        store.release(LEASE, "other");
        assert!(store.is_open("ports", 2), "another tab cannot release it");
        store.release(LEASE, "ports");
        assert!(!store.is_open("ports", 2));
    }

    #[test]
    fn releasing_a_conversation_drops_every_lease_held_in_it() {
        let store = PresenceStore::default();
        store.renew(LEASE, "ports", 2).unwrap();
        store.renew("other-client", "ports", 2).unwrap();
        store.renew("other-tab", "graph", 2).unwrap();
        store.renew("elsewhere", "ports", 3).unwrap();
        store.release_features(&[2]);
        assert!(!store.is_open("ports", 2));
        assert!(!store.is_open("graph", 2));
        assert!(store.is_open("ports", 3), "other conversations keep theirs");
    }

    #[test]
    fn an_unrenewed_lease_lapses_and_is_pruned() {
        let store = PresenceStore::default();
        store.renew(LEASE, "ports", 2).unwrap();
        store.lock().get_mut(LEASE).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert!(!store.is_open("ports", 2));
        store.renew("other-lease", "ports", 3).unwrap();
        assert!(!store.lock().contains_key(LEASE));
    }

    #[test]
    fn leases_are_bounded() {
        let store = PresenceStore::default();
        for n in 0..MAX_LEASES {
            store.renew(&format!("lease-{n}"), "ports", 2).unwrap();
        }
        assert!(store.renew("one-more", "ports", 2).is_err());
        assert!(
            store.renew("lease-0", "ports", 2).is_ok(),
            "renewals still pass"
        );
        for bad in ["", "a b", "x/y", &"a".repeat(MAX_LEASE_ID_CHARS + 1)] {
            assert!(store.renew(bad, "ports", 2).is_err(), "{bad:?}");
        }
    }
}
