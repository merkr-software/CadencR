//! Bounded cache reads and serialized, monotonic policy publication.

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Utc};

use super::super::trust::ManagedTrustStore;
use super::{
    invalid, unavailable, ManagedBlocklistError, ManagedBlocklistErrorCode,
    SignedManagedProviderBlocklist, VerifiedManagedBlocklist, MAX_BLOCKLIST_BYTES,
};

static CACHE_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn load_cached_blocklist(
    path: &Path,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
) -> Result<Option<VerifiedManagedBlocklist>, ManagedBlocklistError> {
    read_envelope(path)?
        .map(|envelope| trust.verify_blocklist(envelope, now))
        .transpose()
}

pub fn load_enforced_blocklist(
    path: &Path,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
) -> Result<Option<VerifiedManagedBlocklist>, ManagedBlocklistError> {
    enforce_cache(path, trust, now, super::pinned_blocklist_url().is_some())
}

fn enforce_cache(
    path: &Path,
    trust: &ManagedTrustStore,
    now: DateTime<Utc>,
    required: bool,
) -> Result<Option<VerifiedManagedBlocklist>, ManagedBlocklistError> {
    let cached = load_cached_blocklist(path, trust, now)?;
    if required && cached.is_none() {
        return Err(unavailable(
            "managed blocklist must be fetched and verified before installation or launch",
        ));
    }
    Ok(cached)
}

fn read_envelope(
    path: &Path,
) -> Result<Option<SignedManagedProviderBlocklist>, ManagedBlocklistError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(unavailable(format!(
                "could not read blocklist cache: {error}"
            )))
        }
    };
    let mut bytes = Vec::new();
    file.take(MAX_BLOCKLIST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| unavailable(format!("could not read blocklist cache: {error}")))?;
    if bytes.len() > MAX_BLOCKLIST_BYTES {
        return Err(ManagedBlocklistError::new(
            ManagedBlocklistErrorCode::BlocklistTooLarge,
            "cached managed-provider blocklist exceeds 1 MiB",
        ));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        invalid(format!(
            "cached managed-provider blocklist is invalid: {error}"
        ))
    })
}

pub(super) fn persist_verified_blocklist(
    path: &Path,
    trust: &ManagedTrustStore,
    envelope: SignedManagedProviderBlocklist,
    now: DateTime<Utc>,
) -> Result<VerifiedManagedBlocklist, ManagedBlocklistError> {
    let verified = trust.verify_blocklist(envelope.clone(), now)?;
    let _guard = CACHE_WRITE_LOCK
        .lock()
        .map_err(|_| unavailable("blocklist cache lock is poisoned"))?;
    if let Some(previous) = trusted_previous(path, trust) {
        // Expiry must not erase the last signed publication high-water mark.
        let generated_at = previous.blocklist.generated_at;
        if verified.blocklist.generated_at < generated_at {
            return Err(invalid("refusing an older signed blocklist publication"));
        }
        if verified.blocklist.generated_at == generated_at
            && verified
                .blocklist
                .signing_bytes()
                .map_err(|error| invalid(error.to_string()))?
                != previous
                    .blocklist
                    .signing_bytes()
                    .map_err(|error| invalid(error.to_string()))?
        {
            return Err(invalid(
                "conflicting signed blocklists have the same publication time",
            ));
        }
    }
    let json = serde_json::to_string(&envelope).map_err(|error| invalid(error.to_string()))?;
    crate::shared::atomic_file::write_atomic_private(path, &json)
        .map_err(|error| unavailable(format!("could not cache verified blocklist: {error}")))?;
    Ok(verified)
}

fn trusted_previous(path: &Path, trust: &ManagedTrustStore) -> Option<VerifiedManagedBlocklist> {
    let previous = read_envelope(path).and_then(|cached| {
        cached
            .map(|envelope| {
                let published = envelope.signed.generated_at;
                trust.verify_blocklist(envelope, published)
            })
            .transpose()
    });
    match previous {
        Ok(previous) => previous,
        Err(error) => {
            // A freshly verified publication repairs corrupt/untrusted cached data.
            // Untrusted timestamps cannot establish a publication high-water mark.
            tracing::warn!(
                code = error.code.as_str(),
                "replacing invalid managed blocklist cache with verified policy"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::{trust::TrustedIndexKey, ManagedSignatureAlgorithm};
    use super::super::{ManagedBlocklistEntry, ManagedIndexSignature, ManagedProviderBlocklist};
    use super::*;
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    fn trust() -> ManagedTrustStore {
        ManagedTrustStore::new([TrustedIndexKey::new(
            "cache-test",
            SigningKey::from_bytes(&[37; 32]).verifying_key().to_bytes(),
        )
        .unwrap()])
    }

    fn signed(now: DateTime<Utc>, blocked: bool) -> SignedManagedProviderBlocklist {
        let signed = ManagedProviderBlocklist {
            schema_version: 1,
            generated_at: now,
            expires_at: now + chrono::Duration::hours(2),
            entries: if blocked {
                vec![ManagedBlocklistEntry {
                    provider_id: "acme-agent".into(),
                    version_requirement: None,
                    archive_sha256: None,
                    reason: "revoked".into(),
                }]
            } else {
                vec![]
            },
        };
        let bytes = signed.signing_bytes().unwrap();
        SignedManagedProviderBlocklist {
            signed,
            signature: ManagedIndexSignature {
                algorithm: ManagedSignatureAlgorithm::Ed25519,
                key_id: "cache-test".into(),
                value: base64::engine::general_purpose::STANDARD
                    .encode(SigningKey::from_bytes(&[37; 32]).sign(&bytes).to_bytes()),
            },
        }
    }

    #[test]
    fn configured_source_requires_verified_cache_before_execution() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let now = Utc::now();
        assert!(enforce_cache(&path, &trust(), now, false)
            .unwrap()
            .is_none());
        assert_eq!(
            enforce_cache(&path, &trust(), now, true).unwrap_err().code,
            ManagedBlocklistErrorCode::BlocklistUnavailable
        );
        persist_verified_blocklist(&path, &trust(), signed(now, false), now).unwrap();
        assert!(enforce_cache(&path, &trust(), now, true).unwrap().is_some());
    }

    #[test]
    fn older_or_conflicting_publications_cannot_undo_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let now = Utc::now();
        persist_verified_blocklist(&path, &trust(), signed(now, true), now).unwrap();
        assert!(persist_verified_blocklist(
            &path,
            &trust(),
            signed(now - chrono::Duration::minutes(1), false),
            now
        )
        .is_err());
        assert!(persist_verified_blocklist(&path, &trust(), signed(now, false), now).is_err());
        let cached = load_cached_blocklist(&path, &trust(), now)
            .unwrap()
            .unwrap();
        assert!(cached
            .blocked_reason("acme-agent", "1.0.0", &"a".repeat(64))
            .unwrap()
            .is_some());
        persist_verified_blocklist(&path, &trust(), signed(now, true), now).unwrap();
    }

    #[test]
    fn fresh_verified_policy_repairs_corrupt_or_untrusted_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let now = Utc::now();
        let mut untrusted = signed(now + chrono::Duration::hours(1), false);
        untrusted.signature.key_id = "untrusted-key".into();
        for bytes in [
            b"{corrupt".to_vec(),
            serde_json::to_vec(&untrusted).unwrap(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(load_cached_blocklist(&path, &trust(), now).is_err());
            persist_verified_blocklist(&path, &trust(), signed(now, true), now).unwrap();
            let cached = load_cached_blocklist(&path, &trust(), now)
                .unwrap()
                .unwrap();
            assert!(cached
                .blocked_reason("acme-agent", "1.0.0", &"a".repeat(64))
                .unwrap()
                .is_some());
        }
    }

    #[test]
    fn expired_cache_preserves_high_water_mark_but_accepts_a_newer_policy() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let now = Utc::now();
        persist_verified_blocklist(&path, &trust(), signed(now, true), now).unwrap();
        let later = now + chrono::Duration::hours(3);
        let mut older = signed(now - chrono::Duration::hours(1), false);
        // Give the older publication a longer validity window and re-sign it.
        older.signed.expires_at = later + chrono::Duration::hours(1);
        older.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[37; 32])
                .sign(&older.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(persist_verified_blocklist(&path, &trust(), older, later).is_err());
        persist_verified_blocklist(&path, &trust(), signed(later, false), later).unwrap();
    }
}
