//! Tracks live remote WebSocket sessions so that revoking a device or turning
//! remote access off can force-close open connections immediately (not just
//! block reconnects).
//!
//! Each remote WS upgrade registers a [`CancellationToken`]; the connection
//! task races the socket against `token.cancelled()`, so cancelling drops the
//! socket without any change to the streaming loops themselves. Revoke cancels
//! every token belonging to the device; stopping the listener cancels them all.
//! Upgraded sockets outlive the HTTP server's graceful shutdown (axum-server
//! stops tracking a connection once hyper hands it off), so this registry is
//! the only thing that closes them.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use tokio_util::sync::CancellationToken;
use tracing::warn;

#[derive(Default)]
struct Inner {
    next_id: u64,
    sessions: HashMap<u64, (i64, CancellationToken)>,
    /// Parent of every session token for the current listener. Cancelled by
    /// [`LiveSessions::cancel_all`] and left cancelled until the next listener
    /// start calls [`LiveSessions::reopen`], so a socket whose upgrade was
    /// already in flight when the listener stopped is closed as it registers.
    scope: CancellationToken,
    /// Devices revoked since launch. Device ids come from an `AUTOINCREMENT`
    /// key and revocation is a soft delete, so an id is never reused; keeping
    /// them lets a socket authenticated just before the revoke (its upgrade
    /// completing after it) be closed as it registers.
    revoked: HashSet<i64>,
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
            registry.lock_inner().sessions.remove(&self.id);
        }
    }
}

impl LiveSessions {
    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| {
            warn!("remote live-session registry lock was poisoned; recovering state");
            self.inner.clear_poison();
            poisoned.into_inner()
        })
    }

    /// Register a session for `device_id`, returning a guard whose `token` the
    /// connection should select on, plus whether this is the device's *first*
    /// live socket (it had none open before this one). The flag lets the caller
    /// fire a one-per-connection "device connected" event without spamming for
    /// the several sockets a single device opens — computed inside the lock so
    /// concurrent upgrades can't both observe themselves as first. The guard
    /// deregisters on drop.
    pub fn register(self: &std::sync::Arc<Self>, device_id: i64) -> (SessionGuard, bool) {
        let (id, token, first_for_device) = {
            let mut inner = self.lock_inner();
            let token = inner.scope.child_token();
            if inner.revoked.contains(&device_id) {
                token.cancel();
            }
            // A session closed at birth (revoked device / stopped listener) is
            // not a connection worth announcing.
            let first_for_device = !token.is_cancelled()
                && !inner
                    .sessions
                    .values()
                    .any(|(other, _)| *other == device_id);
            let id = inner.next_id;
            inner.next_id += 1;
            inner.sessions.insert(id, (device_id, token.clone()));
            (id, token, first_for_device)
        };
        let guard = SessionGuard {
            registry: std::sync::Arc::downgrade(self),
            id,
            token,
        };
        (guard, first_for_device)
    }

    /// Cancel every live session belonging to `device_id` (called on revoke),
    /// and close any socket the device registers afterwards.
    pub fn cancel_device(&self, device_id: i64) {
        let mut inner = self.lock_inner();
        inner.revoked.insert(device_id);
        for (other, token) in inner.sessions.values() {
            if *other == device_id {
                token.cancel();
            }
        }
    }

    /// Cancel every live session (called when the remote listener stops). Any
    /// session registered afterwards is cancelled immediately until
    /// [`Self::reopen`] runs for the next listener.
    pub fn cancel_all(&self) {
        self.lock_inner().scope.cancel();
    }

    /// Accept new sessions again after [`Self::cancel_all`]; called when a new
    /// listener starts. Leaves an open scope (and its sessions) untouched.
    pub fn reopen(&self) {
        let mut inner = self.lock_inner();
        if inner.scope.is_cancelled() {
            inner.scope = CancellationToken::new();
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
        let inner = self.lock_inner();
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
    fn cancel_all_cancels_every_session_until_reopened() {
        let registry = Arc::new(LiveSessions::default());
        let (a, _) = registry.register(1);
        let (b, _) = registry.register(1);
        let (c, _) = registry.register(2);

        registry.cancel_all();

        assert!(a.token.is_cancelled());
        assert!(b.token.is_cancelled());
        assert!(c.token.is_cancelled());
        // An upgrade that completes after the listener stopped is closed too.
        let (late, _) = registry.register(3);
        assert!(late.token.is_cancelled());

        // The next listener accepts sessions again.
        registry.reopen();
        let (fresh, _) = registry.register(3);
        assert!(!fresh.token.is_cancelled());
        // Reopening an open scope must not detach live sessions from it.
        registry.reopen();
        registry.cancel_all();
        assert!(fresh.token.is_cancelled());
    }

    #[test]
    fn revoked_device_sessions_registered_later_are_cancelled() {
        let registry = Arc::new(LiveSessions::default());
        registry.cancel_device(4);
        let (late, late_first) = registry.register(4);
        let (other, _) = registry.register(5);
        assert!(late.token.is_cancelled());
        assert!(
            !late_first,
            "a socket closed at birth is not a new connection"
        );
        assert!(!other.token.is_cancelled());
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

    #[test]
    fn live_session_methods_do_not_panic_after_lock_poison() {
        let registry = Arc::new(LiveSessions::default());
        let poison_target = Arc::clone(&registry);
        let _ = std::thread::spawn(move || {
            let _guard = poison_target.inner.lock().unwrap();
            panic!("poison live sessions lock");
        })
        .join();

        let register_result = std::panic::catch_unwind(|| registry.register(9));
        assert!(register_result.is_ok());
        let cancel_result = std::panic::catch_unwind(|| registry.cancel_device(9));
        assert!(cancel_result.is_ok());
        let cancel_all_result = std::panic::catch_unwind(|| registry.cancel_all());
        assert!(cancel_all_result.is_ok());
        let reopen_result = std::panic::catch_unwind(|| registry.reopen());
        assert!(reopen_result.is_ok());
        let count_result = std::panic::catch_unwind(|| registry.connected_device_count());
        assert!(count_result.is_ok());
        let ids_result = std::panic::catch_unwind(|| registry.connected_device_ids());
        assert!(ids_result.is_ok());
    }
}
