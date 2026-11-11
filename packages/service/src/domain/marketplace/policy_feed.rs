//! What every signed revocation feed the host polls (`theme-blocklist`,
//! `tab-blocklist`) shares: the envelope, its verification against the
//! registry trust, the high-water cache that refuses rollback and
//! equivocation, and the poll cadence. A feed is a [`Feed`] descriptor; what
//! a policy then decides stays with its owner.
use super::storage as io;
use crate::domain::agents::providers::installed::managed::trust::{
    ManagedTrustError, ManagedTrustStore,
};
use crate::domain::agents::providers::installed::managed::ManagedIndexSignature;
use crate::error::AppError;
use cadencr_registry_core::{Blocklist, PreparedBlocklist, RegistryError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A forced poll still waits this long after the previous one.
pub(crate) const FORCE_CADENCE: Duration = Duration::from_secs(5);
/// Any poll waits this long after a failed one.
pub(crate) const RETRY_BACKOFF: Duration = Duration::from_secs(60);

/// One signed revocation feed, entries `E`.
pub(crate) struct Feed<E: 'static> {
    /// Names the policy in errors: `"tab revocation policy"`.
    pub label: &'static str,
    /// The signed envelope's byte budget.
    pub max_bytes: usize,
    /// The high-water cache, inside the storage root.
    pub cache_file: &'static str,
    pub prepare: fn(&Value, bool, DateTime<Utc>) -> Result<PreparedBlocklist<E>, RegistryError>,
    /// Authenticates a cached envelope as a baseline (retired key before its
    /// cutoff, or this feed's exact recovery checkpoint).
    pub baseline: fn(&ManagedTrustStore, &Value, DateTime<Utc>) -> Result<(), ManagedTrustError>,
    /// The feed's coded "policy unavailable" error.
    pub error: fn(String) -> AppError,
    /// Checks (or creates) the storage root as a private directory.
    pub secure: fn(&Path) -> Result<(), AppError>,
    /// Online revocation discovery; cryptographic expiry is independent of it.
    pub poll_cadence: Duration,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Envelope {
    pub signed: Value,
    pub signature: ManagedIndexSignature,
}

pub(crate) struct Verified<E> {
    pub generated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// Signed by a key that is active now (not retired, not a recovery checkpoint).
    pub current_signer: bool,
    pub policy: Blocklist<E>,
}

impl<E> Feed<E> {
    pub(crate) fn fail(&self, message: impl std::fmt::Display) -> AppError {
        (self.error)(message.to_string())
    }

    pub(crate) fn cache(&self, root: &Path) -> PathBuf {
        root.join(self.cache_file)
    }

    pub(crate) fn parse(&self, bytes: &[u8]) -> Result<Envelope, AppError> {
        if bytes.len() > self.max_bytes {
            return Err(self.fail(format!("{} exceeds byte budget", self.label)));
        }
        let value = cadencr_registry_core::parse_json_bytes(bytes).map_err(|e| self.fail(e))?;
        serde_json::from_value(value).map_err(|e| self.fail(e))
    }

    /// The cached high-water envelope; `None` only when no cache exists. A
    /// cache that exists but cannot be read (symlink, corrupt, unsafe
    /// permissions) is an error: it is never silently replaced.
    pub(crate) fn cached(&self, root: &Path) -> Result<Option<Envelope>, AppError> {
        let cache = self.cache(root);
        match cache.symlink_metadata() {
            Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(inspect) => {
                return Err(self.fail(format!(
                    "cannot inspect the {} cache: {inspect}",
                    self.label
                )))
            }
            Ok(_) => {}
        }
        (self.secure)(root).map_err(|e| self.fail(e))?;
        let bytes = io::regular(&cache, self.max_bytes).map_err(|e| self.fail(e))?;
        self.parse(&bytes).map(Some)
    }

    /// `current` requires an active signer and an unexpired window; otherwise
    /// the envelope only needs to authenticate as a policy baseline, expired
    /// or not.
    pub(crate) fn verify(
        &self,
        envelope: &Envelope,
        trust: &ManagedTrustStore,
        current: bool,
        now: DateTime<Utc>,
    ) -> Result<Verified<E>, AppError> {
        let prepared = (self.prepare)(&envelope.signed, !current, now).map_err(|e| self.fail(e))?;
        let signed_now =
            trust.verify_bytes(prepared.signing.canonical_payload(), &envelope.signature);
        if current {
            signed_now.as_ref().map_err(|e| self.fail(e))?;
        } else if signed_now.is_err() {
            let value = serde_json::to_value(envelope).map_err(|e| self.fail(e))?;
            (self.baseline)(trust, &value, now).map_err(|e| self.fail(e))?;
        }
        let instant = |value: &str| {
            DateTime::parse_from_rfc3339(value)
                .map(|at| at.with_timezone(&Utc))
                .map_err(|e| self.fail(e))
        };
        Ok(Verified {
            generated_at: instant(&prepared.policy.generated_at)?,
            expires_at: instant(&prepared.policy.expires_at)?,
            current_signer: signed_now.is_ok(),
            policy: prepared.policy,
        })
    }

    /// Admit a freshly fetched envelope: it must be current, and never older
    /// than (or a different payload at the same time as) the cached
    /// high-water policy.
    pub(crate) fn ingest(
        &self,
        root: &Path,
        envelope: &Envelope,
        trust: &ManagedTrustStore,
        now: DateTime<Utc>,
    ) -> Result<Verified<E>, AppError> {
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().map_err(|e| self.fail(e))?;
        let incoming = self.verify(envelope, trust, true, now)?;
        if let Some(previous) = self.cached(root)? {
            // Exact replay of the cached envelope: nothing to write.
            if same_envelope(envelope, &previous) {
                return Ok(incoming);
            }
            let prior = self.verify(&previous, trust, false, now)?;
            if incoming.generated_at < prior.generated_at
                || (incoming.generated_at == prior.generated_at
                    && envelope.signed != previous.signed)
            {
                return Err(self.fail(format!("{} rollback or equivocation rejected", self.label)));
            }
        }
        (self.secure)(root).map_err(|e| self.fail(e))?;
        crate::shared::atomic_file::write_atomic_private(
            &self.cache(root),
            &serde_json::to_string(envelope).map_err(|e| self.fail(e))?,
        )
        .map_err(|e| self.fail(e))?;
        Ok(incoming)
    }

    /// Run blocking feed IO off the async runtime.
    pub(crate) async fn offload<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        tokio::task::spawn_blocking(operation)
            .await
            .map_err(|e| self.fail(e))?
    }
}

pub(crate) fn same_envelope(left: &Envelope, right: &Envelope) -> bool {
    left.signed == right.signed
        && left.signature.key_id == right.signature.key_id
        && left.signature.value == right.signature.value
}

/// When a feed was last polled, and whether that failed.
#[derive(Default)]
pub(crate) struct PollState {
    pub completed: Option<Instant>,
    pub failure: Option<String>,
}

impl PollState {
    pub(crate) fn needs_poll(&self, cadence: Duration, force: bool, requested: Instant) -> bool {
        match self.completed {
            None => true,                         // Always check remotely after process startup.
            Some(at) if at >= requested => false, // Coalesce even forced callers.
            Some(at) => {
                requested.duration_since(at)
                    >= if self.failure.is_some() {
                        RETRY_BACKOFF
                    } else if force {
                        FORCE_CADENCE
                    } else {
                        cadence
                    }
            }
        }
    }
}

/// One `T` per storage root (tests isolate roots per thread).
pub(crate) type PerRoot<T> = OnceLock<Mutex<HashMap<PathBuf, Arc<T>>>>;

/// `root`'s entry of `roots`, created by `init` on first use.
pub(crate) fn per_root<T>(
    roots: &'static PerRoot<T>,
    root: &Path,
    init: impl FnOnce() -> T,
) -> Result<Arc<T>, String> {
    let mut roots = roots
        .get_or_init(Default::default)
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(roots
        .entry(root.to_owned())
        .or_insert_with(|| Arc::new(init()))
        .clone())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::domain::agents::providers::installed::managed::trust::TrustedIndexKey;
    use crate::domain::agents::providers::installed::managed::ManagedSignatureAlgorithm;
    use base64::Engine as _;
    use chrono::SecondsFormat;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    /// Now plus `offset_minutes`, as a canonical policy timestamp.
    pub(crate) fn at(offset_minutes: i64) -> String {
        (Utc::now() + chrono::Duration::minutes(offset_minutes))
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    pub(crate) fn signed_with(signed: Value, seed: u8, key_id: &str) -> Envelope {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let value = base64::engine::general_purpose::STANDARD.encode(
            key.sign(&cadencr_registry_core::canonical_json_bytes(&signed))
                .to_bytes(),
        );
        Envelope {
            signed,
            signature: ManagedIndexSignature {
                algorithm: ManagedSignatureAlgorithm::Ed25519,
                key_id: key_id.into(),
                value,
            },
        }
    }

    /// A `kind` policy generated `offset_minutes` from now, valid for an
    /// hour, signed by the legacy single-key trust it returns (key `test`,
    /// seed 19).
    pub(crate) fn signed(
        kind: &str,
        offset_minutes: i64,
        entries: Value,
    ) -> (Envelope, ManagedTrustStore) {
        let signed = json!({"schema_version":1,"kind":kind,"generated_at":at(offset_minutes),"expires_at":at(60),"entries":entries});
        let key = SigningKey::from_bytes(&[19; 32]).verifying_key().to_bytes();
        (
            signed_with(signed, 19, "test"),
            ManagedTrustStore::new([TrustedIndexKey::new("test", key).unwrap()]),
        )
    }

    /// The same payload signed by `current-b` (seed 23).
    pub(crate) fn resign_b(envelope: Envelope) -> Envelope {
        signed_with(envelope.signed, 23, "current-b")
    }

    #[test]
    fn poll_cadence_and_backoff_are_independent_from_signature_expiry() {
        let at = Instant::now();
        let cadence = Duration::from_secs(600);
        let ok = PollState {
            completed: Some(at),
            failure: None,
        };
        assert!(!ok.needs_poll(cadence, false, at + cadence - Duration::from_secs(1)));
        assert!(ok.needs_poll(cadence, false, at + cadence));
        assert!(ok.needs_poll(cadence, true, at + FORCE_CADENCE));
        assert!(!ok.needs_poll(cadence, true, at), "coalesced");
        let failed = PollState {
            completed: Some(at),
            failure: Some("offline".into()),
        };
        assert!(!failed.needs_poll(cadence, true, at + RETRY_BACKOFF - Duration::from_secs(1)));
        assert!(failed.needs_poll(cadence, false, at + RETRY_BACKOFF));
    }

    #[test]
    fn per_root_entries_are_shared_within_a_root_only() {
        static ROOTS: PerRoot<()> = OnceLock::new();
        let root = std::env::temp_dir().join("per-root-test");
        let same = per_root(&ROOTS, &root, || ()).unwrap();
        assert!(Arc::ptr_eq(&same, &per_root(&ROOTS, &root, || ()).unwrap()));
        let other = per_root(&ROOTS, &root.join("another-root"), || ()).unwrap();
        assert!(!Arc::ptr_eq(&same, &other));
    }
}
