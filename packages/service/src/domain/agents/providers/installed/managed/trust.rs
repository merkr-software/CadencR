//! Cryptographic trust for managed-provider registry metadata.
//!
//! Contract validation and signature verification are separate on purpose: a
//! well-formed index is not trusted until its exact canonical bytes verify
//! against a key pinned by the host. Public keys supplied by an HTTP caller are
//! never accepted as roots of trust.

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};

use super::{
    ManagedIndexSignature, ManagedProviderIndex, ResolvedManagedProviderPackage,
    SignedManagedProviderIndex,
};

/// Host-owned Ed25519 key authorized to sign the provider index and blocklist.
#[derive(Debug, Clone)]
pub struct TrustedIndexKey {
    key_id: String,
    verifying_key: VerifyingKey,
}

impl TrustedIndexKey {
    pub fn new(key_id: impl Into<String>, public_key: [u8; 32]) -> Result<Self, ManagedTrustError> {
        let key_id = key_id.into();
        validate_key_id(&key_id)?;
        let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|error| {
            ManagedTrustError::new(
                ManagedTrustErrorCode::InvalidPublicKey,
                format!("trusted index key {key_id:?} is invalid: {error}"),
            )
        })?;
        Ok(Self {
            key_id,
            verifying_key,
        })
    }

    fn from_base64(key_id: impl Into<String>, public_key: &str) -> Result<Self, ManagedTrustError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(public_key)
            .map_err(|error| {
                ManagedTrustError::new(
                    ManagedTrustErrorCode::InvalidPublicKey,
                    format!("pinned managed-provider key is not valid base64: {error}"),
                )
            })?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
            ManagedTrustError::new(
                ManagedTrustErrorCode::InvalidPublicKey,
                "pinned managed-provider Ed25519 public key must be 32 bytes",
            )
        })?;
        Self::new(key_id, bytes)
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }
}

/// A host-owned keyring. An empty keyring fails closed.
#[derive(Debug, Clone, Default)]
pub struct ManagedTrustStore {
    keys: BTreeMap<String, VerifyingKey>,
}

impl ManagedTrustStore {
    pub fn new(keys: impl IntoIterator<Item = TrustedIndexKey>) -> Self {
        Self {
            keys: keys
                .into_iter()
                .map(|key| (key.key_id, key.verifying_key))
                .collect(),
        }
    }

    pub fn verify_index(
        &self,
        envelope: SignedManagedProviderIndex,
    ) -> Result<VerifiedManagedProviderIndex, ManagedTrustError> {
        envelope.validate_contract().map_err(|error| {
            ManagedTrustError::new(
                ManagedTrustErrorCode::InvalidSignedPayload,
                format!("managed provider index was rejected: {error}"),
            )
        })?;
        let signing_bytes = envelope.signed.signing_bytes().map_err(|error| {
            ManagedTrustError::new(
                ManagedTrustErrorCode::InvalidSignedPayload,
                format!("managed provider index could not be canonicalized: {error}"),
            )
        })?;
        let signer_key_id = self.verify_bytes(&signing_bytes, &envelope.signature)?;
        Ok(VerifiedManagedProviderIndex {
            envelope,
            signer_key_id,
        })
    }

    pub(super) fn verify_bytes(
        &self,
        bytes: &[u8],
        signature: &ManagedIndexSignature,
    ) -> Result<String, ManagedTrustError> {
        if self.keys.is_empty() {
            return Err(ManagedTrustError::new(
                ManagedTrustErrorCode::TrustNotConfigured,
                "managed provider trust is not configured in this build",
            ));
        }
        let signer_key_id = signature.key_id.clone();
        let key = self.keys.get(&signer_key_id).ok_or_else(|| {
            ManagedTrustError::new(
                ManagedTrustErrorCode::UnknownSigningKey,
                format!(
                    "managed metadata uses unknown signing key {:?}",
                    signature.key_id
                ),
            )
        })?;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&signature.value)
            .map_err(|error| {
                invalid_signature(format!("signature is not valid base64: {error}"))
            })?;
        let signature = Signature::from_slice(&decoded).map_err(|error| {
            invalid_signature(format!("signature has an invalid shape: {error}"))
        })?;
        key.verify_strict(bytes, &signature)
            .map_err(|_| invalid_signature("managed metadata signature verification failed"))?;
        Ok(signer_key_id)
    }
}

/// The production keyring seam. A marketplace release compiles its reviewed
/// key id/public key into the binary. Keeping an unconfigured or malformed
/// build empty is safer than shipping a fixture key or trusting renderer input.
pub fn pinned_index_trust_store() -> ManagedTrustStore {
    match pinned_index_trust_status() {
        PinnedIndexTrustStatus::Configured { key } => ManagedTrustStore::new([key]),
        PinnedIndexTrustStatus::Unconfigured | PinnedIndexTrustStatus::Invalid { .. } => {
            ManagedTrustStore::default()
        }
    }
}

#[derive(Debug, Clone)]
pub enum PinnedIndexTrustStatus {
    Unconfigured,
    Configured { key: TrustedIndexKey },
    Invalid { code: &'static str, message: String },
}

pub fn pinned_index_trust_status() -> PinnedIndexTrustStatus {
    pinned_index_trust_status_from(
        option_env!("CADENCR_MANAGED_PROVIDER_KEY_ID"),
        option_env!("CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64"),
    )
}

fn pinned_index_trust_status_from(
    key_id: Option<&str>,
    public_key: Option<&str>,
) -> PinnedIndexTrustStatus {
    match (key_id, public_key) {
        (None, None) => PinnedIndexTrustStatus::Unconfigured,
        (Some(key_id), Some(public_key)) => {
            match TrustedIndexKey::from_base64(key_id, public_key) {
                Ok(key) => PinnedIndexTrustStatus::Configured { key },
                Err(error) => PinnedIndexTrustStatus::Invalid {
                    code: "PINNED_TRUST_CONFIGURATION_INVALID",
                    message: error.message,
                },
            }
        }
        _ => PinnedIndexTrustStatus::Invalid {
            code: "PINNED_TRUST_CONFIGURATION_INVALID",
            message: "managed-provider key id and public key must be compiled in together".into(),
        },
    }
}

/// An index whose signature was verified by a host-owned trust store.
#[derive(Debug, Clone)]
pub struct VerifiedManagedProviderIndex {
    envelope: SignedManagedProviderIndex,
    signer_key_id: String,
}

impl VerifiedManagedProviderIndex {
    pub fn index(&self) -> &ManagedProviderIndex {
        &self.envelope.signed
    }

    pub fn signer_key_id(&self) -> &str {
        &self.signer_key_id
    }

    pub fn resolve_current_platform(
        &self,
        provider_id: &str,
        provider_version: &str,
        app_version: &str,
    ) -> Result<ResolvedManagedProviderPackage, super::ManagedContractError> {
        self.envelope
            .resolve_current_platform(provider_id, provider_version, app_version)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedTrustErrorCode {
    TrustNotConfigured,
    InvalidPublicKey,
    UnknownSigningKey,
    InvalidSignature,
    InvalidSignedPayload,
}

impl ManagedTrustErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TrustNotConfigured => "TRUST_NOT_CONFIGURED",
            Self::InvalidPublicKey => "INVALID_PUBLIC_KEY",
            Self::UnknownSigningKey => "UNKNOWN_SIGNING_KEY",
            Self::InvalidSignature => "REGISTRY_SIGNATURE_INVALID",
            Self::InvalidSignedPayload => "SIGNED_PROVIDER_INDEX_INVALID",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedTrustError {
    pub code: ManagedTrustErrorCode,
    pub message: String,
}

impl ManagedTrustError {
    fn new(code: ManagedTrustErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ManagedTrustError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ManagedTrustError {}

fn validate_key_id(key_id: &str) -> Result<(), ManagedTrustError> {
    let valid = (1..=128).contains(&key_id.len())
        && key_id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(ManagedTrustError::new(
            ManagedTrustErrorCode::InvalidPublicKey,
            "trusted index key id is invalid",
        ))
    }
}

fn invalid_signature(message: impl Into<String>) -> ManagedTrustError {
    ManagedTrustError::new(ManagedTrustErrorCode::InvalidSignature, message)
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use ed25519_dalek::{Signer as _, SigningKey};

    use super::*;

    const VALID_INDEX: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/managed_provider_index/v1/valid.json"
    ));

    fn signed_fixture() -> (ManagedTrustStore, SignedManagedProviderIndex) {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let trusted = TrustedIndexKey::new("registry-test", signing_key.verifying_key().to_bytes())
            .expect("test key");
        let mut index: SignedManagedProviderIndex =
            serde_json::from_str(VALID_INDEX).expect("managed index fixture");
        index.signature.key_id = "registry-test".into();
        let bytes = index.signed.signing_bytes().expect("signing bytes");
        index.signature.value =
            base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&bytes).to_bytes());
        (ManagedTrustStore::new([trusted]), index)
    }

    #[test]
    fn verifies_exact_canonical_index_bytes() {
        let (store, index) = signed_fixture();
        let verified = store.verify_index(index).expect("valid signature");
        assert_eq!(verified.signer_key_id(), "registry-test");
        assert_eq!(verified.index().packages[0].agent.id, "acme-agent");
    }

    #[test]
    fn rejects_tampering_after_signing() {
        let (store, mut index) = signed_fixture();
        index.signed.packages[0].agent.name = "Tampered".into();
        let error = store.verify_index(index).expect_err("tampering must fail");
        assert_eq!(error.code, ManagedTrustErrorCode::InvalidSignature);
    }

    #[test]
    fn empty_and_unknown_keyrings_fail_closed() {
        let (_, index) = signed_fixture();
        let error = ManagedTrustStore::default()
            .verify_index(index.clone())
            .expect_err("empty keyring must fail");
        assert_eq!(error.code, ManagedTrustErrorCode::TrustNotConfigured);

        let other_key = SigningKey::from_bytes(&[8; 32]);
        let store = ManagedTrustStore::new([TrustedIndexKey::new(
            "another",
            other_key.verifying_key().to_bytes(),
        )
        .expect("other key")]);
        let error = store
            .verify_index(index)
            .expect_err("unknown key must fail");
        assert_eq!(error.code, ManagedTrustErrorCode::UnknownSigningKey);
    }

    #[test]
    fn partial_pinned_configuration_is_invalid_not_unconfigured() {
        assert!(matches!(
            pinned_index_trust_status_from(None, None),
            PinnedIndexTrustStatus::Unconfigured
        ));
        for status in [
            pinned_index_trust_status_from(Some("registry"), None),
            pinned_index_trust_status_from(None, Some("AAAA")),
        ] {
            assert!(matches!(status, PinnedIndexTrustStatus::Invalid { .. }));
        }
    }
}
