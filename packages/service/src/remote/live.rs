//! Tracks live remote WebSocket sessions so that revoking a device can
//! force-close its open connections immediately (not just block reconnects).
//!
//! Each remote WS upgrade registers a [`CancellationToken`]; the connection
//! task races the socket against `token.cancelled()`, so cancelling drops the
//! socket without any change to the streaming loops themselves. Revoke cancels
//! every token belonging to the device.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Inner {
    next_id: u64,
    sessions: HashMap<u64, (i64, CancellationToken)>,
}

/// Registry of live remote sessions keyed by an internal connection id.
#[derive(Default)]
pub struct LiveSessions {
    inner: Mutex<Inner>,
}

/// RAII guard returned by [`LiveSessions::register`]. Dropping it deregisters
/// the session, so a normal disconnect can't leak entries.
pub struct SessionGuard {
    registry: std::sync::Weak<LiveSessions>,
    id: u64,
    pub token: CancellationToken,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            registry.inner.lock().unwrap().sessions.remove(&self.id);
        }
    }
}

impl LiveSessions {
    /// Register a session for `device_id`, returning a guard whose `token` the
    /// connection should select on, plus whether this is the device's *first*
    /// live socket (it had none open before this one). The flag lets the caller
    /// fire a one-per-connection "device connected" event without spamming for
    /// the several sockets a single device opens — computed inside the lock so
    /// concurrent upgrades can't both observe themselves as first. The guard
    /// deregisters on drop.
    pub fn register(self: &std::sync::Arc<Self>, device_id: i64) -> (SessionGuard, bool) {
        let token = CancellationToken::new();
        let (id, first_for_device) = {
            let mut inner = self.inner.lock().unwrap();
            let first_for_device = !inner
                .sessions
                .values()
                .any(|(other, _)| *other == device_id);
            let id = inner.next_id;
            inner.next_id += 1;
            inner.sessions.insert(id, (device_id, token.clone()));
            (id, first_for_device)
        };
        let guard = SessionGuard {
            registry: std::sync::Arc::downgrade(self),
            id,
            token,
        };
        (guard, first_for_device)
    }

    /// Cancel every live session belonging to `device_id` (called on revoke).
    pub fn cancel_device(&self, device_id: i64) {
        let inner = self.inner.lock().unwrap();
        for (other, token) in inner.sessions.values() {
            if *other == device_id {
                token.cancel();
            }
        }
    }

    /// Number of distinct devices with at least one live session right now.
    /// Drives the "N connected" badge in the host sidebar; a single device with
    /// several open tabs counts once.
    pub fn connected_device_count(&self) -> usize {
        self.connected_device_ids().len()
    }

    /// The distinct device ids with at least one live session right now. The push
    /// dispatcher uses this to skip devices that already hold a WebSocket — a
    /// foregrounded tab gets the live/in-app path, so pushing to it too would
    /// double-notify.
    pub fn connected_device_ids(&self) -> std::collections::HashSet<i64> {
        let inner = self.inner.lock().unwrap();
        inner
            .sessions
            .values()
            .map(|(device_id, _)| *device_id)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn cancel_targets_only_the_revoked_device() {
        let registry = Arc::new(LiveSessions::default());
        let (keep, _) = registry.register(1);
        let (drop_me, _) = registry.register(2);

        registry.cancel_device(2);

        assert!(!keep.token.is_cancelled());
        assert!(drop_me.token.is_cancelled());
    }

    #[test]
    fn connected_device_count_dedupes_by_device() {
        let registry = Arc::new(LiveSessions::default());
        let _a1 = registry.register(1);
        let _a2 = registry.register(1); // same device, second tab
        let _b = registry.register(2);
        assert_eq!(registry.connected_device_count(), 2);
    }

    #[test]
    fn register_flags_only_the_first_socket_per_device() {
        let registry = Arc::new(LiveSessions::default());
        let (first, first_flag) = registry.register(1);
        let (_second, second_flag) = registry.register(1); // same device, second tab
        let (_other, other_flag) = registry.register(2);
        assert!(first_flag, "first socket for a device should be flagged");
        assert!(
            !second_flag,
            "a second concurrent socket must not be flagged"
        );
        assert!(other_flag, "a different device's first socket is flagged");

        // Once every socket for device 1 closes, the next one is "first" again.
        drop(first);
        drop(_second);
        let (_again, again_flag) = registry.register(1);
        assert!(again_flag, "reconnecting after a full disconnect re-flags");
    }

    #[test]
    fn guard_deregisters_on_drop() {
        let registry = Arc::new(LiveSessions::default());
        {
            let (_guard, _) = registry.register(7);
            assert_eq!(registry.inner.lock().unwrap().sessions.len(), 1);
        }
        assert_eq!(registry.inner.lock().unwrap().sessions.len(), 0);
        // Cancelling a now-empty device is a no-op (must not panic).
        registry.cancel_device(7);
    }
}
