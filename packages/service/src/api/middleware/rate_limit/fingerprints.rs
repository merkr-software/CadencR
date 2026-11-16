//! What the remote listener has learned about presented device tokens, keyed
//! by a fingerprint (a hash under a per-listener random key, never the token).

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::time::{Duration, Instant};

/// How long a verified token keeps its device budget without a new success.
const VERIFIED_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a token answered with 401 is shed without verification while its
/// peer is locked out. Each new 401 refreshes it.
const REJECTED_TTL: Duration = Duration::from_secs(60 * 60);
/// Paired devices are few; the caps only bound memory.
const CAP: usize = 1024;

/// What the limiter knows about a presented token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Credential {
    /// Verified recently for this device.
    Device(i64),
    /// Answered with 401 recently.
    Rejected,
    /// Never seen, or forgotten.
    Unknown,
}

/// Fingerprinted tokens with a bounded lifetime and count.
struct Recent<V> {
    ttl: Duration,
    entries: HashMap<u64, (V, Instant)>,
}

impl<V: Copy> Recent<V> {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: HashMap::new(),
        }
    }

    fn get(&self, fingerprint: u64, now: Instant) -> Option<V> {
        let (value, seen) = self.entries.get(&fingerprint)?;
        (now.duration_since(*seen) < self.ttl).then_some(*value)
    }

    fn insert(&mut self, fingerprint: u64, value: V, now: Instant) {
        if let Some(entry) = self.entries.get_mut(&fingerprint) {
            *entry = (value, now);
            return;
        }
        if self.entries.len() >= CAP {
            // Expired entries are the oldest, so they go first.
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, (_, seen))| *seen)
                .map(|(key, _)| *key);
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(fingerprint, (value, now));
    }

    fn remove(&mut self, fingerprint: u64) {
        self.entries.remove(&fingerprint);
    }
}

pub(super) struct Fingerprints {
    hasher: std::hash::RandomState,
    verified: Recent<i64>,
    rejected: Recent<()>,
}

impl Default for Fingerprints {
    fn default() -> Self {
        Self {
            hasher: std::hash::RandomState::new(),
            verified: Recent::new(VERIFIED_TTL),
            rejected: Recent::new(REJECTED_TTL),
        }
    }
}

impl Fingerprints {
    pub(super) fn fingerprint(&self, token: &str) -> u64 {
        self.hasher.hash_one(token)
    }

    pub(super) fn credential(&self, fingerprint: u64, now: Instant) -> Credential {
        if let Some(device) = self.verified.get(fingerprint, now) {
            Credential::Device(device)
        } else if self.rejected.get(fingerprint, now).is_some() {
            Credential::Rejected
        } else {
            Credential::Unknown
        }
    }

    pub(super) fn verified(&mut self, fingerprint: u64, device: i64, now: Instant) {
        self.rejected.remove(fingerprint);
        self.verified.insert(fingerprint, device, now);
    }

    pub(super) fn rejected(&mut self, fingerprint: u64, now: Instant) {
        self.verified.remove(fingerprint);
        self.rejected.insert(fingerprint, (), now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_moves_between_verified_rejected_and_expired() {
        let mut known = Fingerprints::default();
        let now = Instant::now();
        let fingerprint = known.fingerprint("token");
        assert_eq!(known.credential(fingerprint, now), Credential::Unknown);

        known.verified(fingerprint, 7, now);
        assert_eq!(known.credential(fingerprint, now), Credential::Device(7));
        assert_eq!(
            known.credential(fingerprint, now + VERIFIED_TTL),
            Credential::Unknown
        );

        known.rejected(fingerprint, now);
        assert_eq!(known.credential(fingerprint, now), Credential::Rejected);
        assert_eq!(
            known.credential(fingerprint, now + REJECTED_TTL),
            Credential::Unknown
        );

        known.verified(fingerprint, 7, now);
        assert_eq!(known.credential(fingerprint, now), Credential::Device(7));
    }

    #[test]
    fn fingerprints_are_per_token() {
        let known = Fingerprints::default();
        assert_ne!(known.fingerprint("a"), known.fingerprint("b"));
        assert_eq!(known.fingerprint("a"), known.fingerprint("a"));
    }

    #[test]
    fn the_cap_evicts_the_oldest_entry() {
        let mut recent = Recent::new(VERIFIED_TTL);
        let start = Instant::now();
        for n in 0..CAP as u64 {
            recent.insert(n, n as i64, start + Duration::from_millis(n));
        }
        let later = start + Duration::from_secs(1);
        recent.insert(u64::MAX, -1, later);
        assert_eq!(recent.entries.len(), CAP);
        assert_eq!(recent.get(0, later), None, "the oldest was evicted");
        assert_eq!(recent.get(u64::MAX, later), Some(-1));
    }
}
