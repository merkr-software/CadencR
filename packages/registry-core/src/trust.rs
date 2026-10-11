//! Offline-root-authorized metadata generations; catalog keys cannot authorize their successors.
use std::{collections::BTreeMap, path::Path};

use base64::prelude::{Engine as _, BASE64_STANDARD};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer as _, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::{canonical_json_bytes, RegistryError};

mod catalog;
pub use catalog::CatalogTrustPurpose;
mod files;
mod policy;
pub use files::RegistryTrustFiles;

pub const MAX_TRUST_MANIFEST_BYTES: u64 = 64 * 1024;
const DOMAIN: &[u8] = b"cadencr.registry.trust.v1\0";
type DelegatedKeys = BTreeMap<String, (VerifyingKey, Option<DateTime<Utc>>)>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryTrustManifest {
    pub schema_version: u64,
    pub kind: String,
    pub generation: u64,
    pub keys: Vec<RegistryTrustKey>,
    #[serde(default)]
    pub revoked_key_ids: Vec<String>,
    /// Exact canonical-envelope hashes independently endorsed by the offline root.
    #[serde(default)]
    pub recovery_catalog_sha256: Vec<String>,
    /// Exact offline-root-endorsed theme-policy high-water envelopes; never current authority.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery_theme_policy_sha256: Vec<String>,
    /// Provider-policy checkpoints are independent from theme and catalog checkpoints.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recovery_provider_policy_sha256: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryTrustKey {
    pub key_id: String,
    pub public_key_base64: String,
    /// Present only for historical keys; they cannot sign new metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedRegistryTrustManifest {
    pub signed: RegistryTrustManifest,
    pub signature: RegistryRootSignature,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryRootSignature {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}

/// Constructible only by verification against an independently pinned offline root.
#[derive(Debug, Clone)]
pub struct VerifiedRegistryTrust {
    envelope: SignedRegistryTrustManifest,
    keys: DelegatedKeys,
}

impl VerifiedRegistryTrust {
    pub fn generation(&self) -> u64 {
        self.envelope.signed.generation
    }
    pub fn envelope(&self) -> &SignedRegistryTrustManifest {
        &self.envelope
    }
    pub fn active_key(&self, id: &str) -> Result<&VerifyingKey, RegistryError> {
        let (key, retired) = self
            .keys
            .get(id)
            .ok_or_else(|| invalid("unknown or revoked key"))?;
        if retired.is_some() {
            return Err(invalid("retired key cannot authenticate current metadata"));
        }
        Ok(key)
    }
    pub fn validate_successor(&self, previous: &Self) -> Result<(), RegistryError> {
        if self.generation() < previous.generation() {
            return Err(invalid("trust generation rollback rejected"));
        }
        if self.generation() == previous.generation()
            && manifest_bytes(&self.envelope.signed)? != manifest_bytes(&previous.envelope.signed)?
        {
            return Err(invalid("same-generation trust equivocation rejected"));
        }
        for id in &previous.envelope.signed.revoked_key_ids {
            if !self.envelope.signed.revoked_key_ids.contains(id) {
                return Err(invalid("a revoked key cannot regain authority"));
            }
        }
        for (id, (old_key, old_retirement)) in &previous.keys {
            match self.keys.get(id) {
                Some((key, retirement))
                    if key != old_key
                        || old_retirement.is_some() && retirement != old_retirement =>
                {
                    return Err(invalid(
                        "key identities and existing retirement cutoffs are immutable",
                    ));
                }
                None if !self.envelope.signed.revoked_key_ids.contains(id) => {
                    return Err(invalid(
                        "removing a delegated key requires explicit revocation",
                    ));
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[bon::builder]
pub fn verify_registry_trust_manifest(
    bytes: &[u8],
    root_public_key: &[u8; 32],
    root_key_id: &str,
    #[builder(default = 1)] minimum_generation: u64,
) -> Result<VerifiedRegistryTrust, RegistryError> {
    crate::validate_signing_key_id(root_key_id)?;
    if minimum_generation == 0 {
        return Err(invalid("minimum trust generation must be positive"));
    }
    if bytes.len() as u64 > MAX_TRUST_MANIFEST_BYTES {
        return Err(invalid("trust manifest exceeds byte limit"));
    }
    let value =
        crate::parse_json_bytes(bytes).map_err(|_| invalid("trust manifest must be valid JSON"))?;
    let envelope: SignedRegistryTrustManifest =
        serde_json::from_value(value).map_err(|_| invalid("trust manifest schema is invalid"))?;
    if envelope.signature.algorithm != "ed25519" || envelope.signature.key_id != root_key_id {
        return Err(invalid(
            "trust manifest offline root identity does not match",
        ));
    }
    let key = VerifyingKey::from_bytes(root_public_key)
        .map_err(|_| invalid("offline root public key is invalid"))?;
    if key.is_weak() {
        return Err(invalid("offline root public key is weak"));
    }
    let signature = decode_signature(&envelope.signature.value)?;
    key.verify_strict(&manifest_bytes(&envelope.signed)?, &signature)
        .map_err(|_| invalid("trust manifest offline root signature is invalid"))?;
    let keys = validate(&envelope.signed, root_public_key)?;
    if envelope.signed.generation < minimum_generation {
        return Err(invalid("trust manifest is below minimum generation"));
    }
    Ok(VerifiedRegistryTrust { envelope, keys })
}

pub fn sign_registry_trust_manifest(
    payload_file: &Path,
    root_private_key_file: &Path,
    root_key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    crate::validate_signing_key_id(root_key_id)?;
    let bytes = crate::safe_io::read_bounded_regular(payload_file, MAX_TRUST_MANIFEST_BYTES)
        .map_err(|e| invalid(format!("cannot read trust payload: {e}")))?;
    let value =
        crate::parse_json_bytes(&bytes).map_err(|_| invalid("trust payload must be valid JSON"))?;
    let manifest: RegistryTrustManifest =
        serde_json::from_value(value).map_err(|_| invalid("trust manifest schema is invalid"))?;
    let key = crate::signing::read_signing_key(root_private_key_file)?;
    validate(&manifest, key.verifying_key().as_bytes())?;
    let signature = RegistryRootSignature {
        algorithm: "ed25519".into(),
        key_id: root_key_id.into(),
        value: BASE64_STANDARD.encode(key.sign(&manifest_bytes(&manifest)?).to_bytes()),
    };
    let mut bytes = canonical_json_bytes(
        &serde_json::to_value(SignedRegistryTrustManifest {
            signed: manifest,
            signature,
        })
        .map_err(|e| invalid(e.to_string()))?,
    );
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_TRUST_MANIFEST_BYTES {
        return Err(invalid("signed trust manifest exceeds byte limit"));
    }
    Ok(bytes)
}

fn validate(
    manifest: &RegistryTrustManifest,
    root: &[u8; 32],
) -> Result<DelegatedKeys, RegistryError> {
    if manifest.schema_version != 1
        || manifest.kind != "registry-trust"
        || manifest.generation == 0
        || manifest.keys.is_empty()
        || manifest.keys.len() > 16
        || manifest.revoked_key_ids.len() > 64
        || manifest.recovery_catalog_sha256.len() > 16
        || manifest.recovery_theme_policy_sha256.len() > 16
        || manifest.recovery_provider_policy_sha256.len() > 16
    {
        return Err(invalid("trust manifest shape or bounds are invalid"));
    }
    let mut keys = BTreeMap::new();
    for entry in &manifest.keys {
        crate::validate_signing_key_id(&entry.key_id)?;
        let bytes = decode_registry_public_key(&entry.public_key_base64)?;
        if &bytes == root {
            return Err(invalid("offline root must not be a metadata signing key"));
        }
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| invalid("invalid delegated key"))?;
        let retired_at = entry
            .retired_at
            .as_ref()
            .map(|at| {
                DateTime::parse_from_rfc3339(at)
                    .map(|at| at.with_timezone(&Utc))
                    .map_err(|_| invalid("key retired_at is invalid"))
            })
            .transpose()?;
        if key.is_weak()
            || keys
                .insert(entry.key_id.clone(), (key, retired_at))
                .is_some()
        {
            return Err(invalid("weak or duplicate delegated key"));
        }
    }
    if !keys.values().any(|(_, retired)| retired.is_none()) {
        return Err(invalid("trust manifest needs an active metadata key"));
    }
    let mut revoked = std::collections::BTreeSet::new();
    for id in &manifest.revoked_key_ids {
        crate::validate_signing_key_id(id)?;
        if keys.contains_key(id) || !revoked.insert(id) {
            return Err(invalid(
                "revoked keys must be unique and absent from delegated keys",
            ));
        }
    }
    let mut checkpoints = std::collections::BTreeSet::new();
    for hash in manifest
        .recovery_catalog_sha256
        .iter()
        .chain(&manifest.recovery_theme_policy_sha256)
        .chain(&manifest.recovery_provider_policy_sha256)
    {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !checkpoints.insert(hash)
        {
            return Err(invalid(
                "recovery checkpoint hashes must be unique lowercase SHA-256",
            ));
        }
    }
    Ok(keys)
}

pub fn decode_registry_public_key(encoded: &str) -> Result<[u8; 32], RegistryError> {
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| invalid("invalid public key base64"))?;
    if BASE64_STANDARD.encode(&bytes) != encoded {
        return Err(invalid("public key base64 is not canonical"));
    }
    bytes
        .try_into()
        .map_err(|_| invalid("Ed25519 public key must contain 32 bytes"))
}
fn decode_signature(encoded: &str) -> Result<Signature, RegistryError> {
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| invalid("invalid root signature base64"))?;
    if BASE64_STANDARD.encode(&bytes) != encoded {
        return Err(invalid("root signature base64 is not canonical"));
    }
    Signature::from_slice(&bytes).map_err(|_| invalid("invalid root signature size"))
}
fn manifest_bytes(manifest: &RegistryTrustManifest) -> Result<Vec<u8>, RegistryError> {
    let value = serde_json::to_value(manifest).map_err(|e| invalid(e.to_string()))?;
    Ok([DOMAIN, canonical_json_bytes(&value).as_slice()].concat())
}
fn invalid(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn key(seed: u8, id: &str) -> Value {
        json!({"key_id":id,"public_key_base64":BASE64_STANDARD.encode(ed25519_dalek::SigningKey::from_bytes(&[seed;32]).verifying_key().to_bytes())})
    }
    fn document(generation: u64, keys: Vec<Value>) -> Value {
        json!({"schema_version":1,"kind":"registry-trust","generation":generation,"keys":keys,"revoked_key_ids":[],"recovery_catalog_sha256":[]})
    }
    fn signed(payload: Value, seed: u8) -> Vec<u8> {
        let typed: RegistryTrustManifest = serde_json::from_value(payload.clone()).unwrap();
        let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        serde_json::to_vec(&json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":"offline-root","value":BASE64_STANDARD.encode(key.sign(&manifest_bytes(&typed).unwrap()).to_bytes())}})).unwrap()
    }
    fn verify(payload: Value) -> VerifiedRegistryTrust {
        verify_registry_trust_manifest()
            .bytes(&signed(payload, 97))
            .root_public_key(
                &ed25519_dalek::SigningKey::from_bytes(&[97; 32])
                    .verifying_key()
                    .to_bytes(),
            )
            .root_key_id("offline-root")
            .call()
            .unwrap()
    }
    fn catalog(seed: u8, id: &str, generated: chrono::DateTime<Utc>) -> Value {
        let package: Value = serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        let prepared = crate::prepare_publication_index()
            .packages(vec![package])
            .generated_at(&generated.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .expires_at(
                &(generated + chrono::Duration::days(1))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            )
            .call()
            .unwrap();
        let payload: Value = serde_json::from_slice(prepared.canonical_payload()).unwrap();
        json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":id,"value":BASE64_STANDARD.encode(ed25519_dalek::SigningKey::from_bytes(&[seed;32]).sign(prepared.canonical_payload()).to_bytes())}})
    }
    #[test]
    fn ordinary_catalog_verification_retains_closed_envelope_signature_and_payload_validation() {
        let now = Utc::now();
        let valid = catalog(19, "a", now - chrono::Duration::minutes(3));
        let profile = verify(document(1, vec![key(19, "a")]));
        let mut unknown_envelope = valid.clone();
        unknown_envelope["unknown"] = json!(true);
        let mut unknown_signature = valid.clone();
        unknown_signature["signature"]["unknown"] = json!(true);
        let mut malformed_payload = valid.clone();
        malformed_payload["signed"]["packages"] = json!("not-an-array");
        malformed_payload["signature"]["value"] = json!(BASE64_STANDARD.encode(
            ed25519_dalek::SigningKey::from_bytes(&[19; 32])
                .sign(&canonical_json_bytes(&malformed_payload["signed"]))
                .to_bytes()
        ));
        for purpose in [
            CatalogTrustPurpose::Current,
            CatalogTrustPurpose::Historical,
            CatalogTrustPurpose::Baseline,
        ] {
            assert_eq!(
                profile.verify_catalog(&valid, purpose, now).unwrap(),
                canonical_json_bytes(&valid["signed"])
            );
            for invalid in [&unknown_envelope, &unknown_signature, &malformed_payload] {
                assert!(profile.verify_catalog(invalid, purpose, now).is_err());
            }
        }
    }
    #[test]
    fn exact_catalog_checkpoint_still_requires_a_valid_payload() {
        let now = Utc::now();
        let mut malformed = catalog(19, "a", now - chrono::Duration::minutes(3));
        malformed["signed"]["packages"] = json!("not-an-array");
        let mut payload = document(2, vec![key(23, "b")]);
        payload["revoked_key_ids"] = json!(["a"]);
        payload["recovery_catalog_sha256"] =
            json!([VerifiedRegistryTrust::catalog_digest(&malformed)]);
        assert!(verify(payload)
            .verify_catalog(&malformed, CatalogTrustPurpose::Baseline, now)
            .is_err());
    }
    #[test]
    fn ordinary_rotation_authorizes_successor_not_fresh_metadata_by_retired_key() {
        let now = Utc::now();
        let a = catalog(19, "a", now - chrono::Duration::minutes(3));
        let b = catalog(23, "b", now - chrono::Duration::seconds(30));
        let first = verify(document(1, vec![key(19, "a")]));
        let mut retired = key(19, "a");
        retired["retired_at"] = json!((now - chrono::Duration::minutes(1)).to_rfc3339());
        let next = verify(document(2, vec![retired, key(23, "b")]));
        next.validate_successor(&first).unwrap();
        assert!(next
            .verify_catalog(&a, CatalogTrustPurpose::Current, now)
            .is_err());
        next.verify_catalog(&a, CatalogTrustPurpose::Baseline, now)
            .unwrap();
        next.verify_catalog(&a, CatalogTrustPurpose::Historical, now)
            .unwrap();
        next.verify_catalog(&b, CatalogTrustPurpose::Current, now)
            .unwrap();
        let forged = catalog(19, "a", now - chrono::Duration::seconds(20));
        assert!(next
            .verify_catalog(&forged, CatalogTrustPurpose::Historical, now)
            .is_err());
    }
    #[test]
    fn compromised_key_has_no_authority_and_recovery_is_exact_root_checkpoint_only() {
        let now = Utc::now();
        let a = catalog(19, "a", now - chrono::Duration::minutes(3));
        let mut payload = document(3, vec![key(23, "b")]);
        payload["revoked_key_ids"] = json!(["a"]);
        let profile = verify(payload.clone());
        assert!(profile
            .verify_catalog(&a, CatalogTrustPurpose::Baseline, now)
            .is_err());
        payload["generation"] = json!(4);
        payload["recovery_catalog_sha256"] = json!([VerifiedRegistryTrust::catalog_digest(&a)]);
        let recovery = verify(payload);
        recovery.validate_successor(&profile).unwrap();
        recovery
            .verify_catalog(&a, CatalogTrustPurpose::Baseline, now)
            .unwrap();
        assert!(recovery
            .verify_catalog(&a, CatalogTrustPurpose::Historical, now)
            .is_err());
        assert!(recovery
            .verify_catalog(&a, CatalogTrustPurpose::Current, now)
            .is_err());
        let mut changed = a;
        changed["signed"]["packages"][0]["agent"]["name"] = json!("forged");
        assert!(recovery
            .verify_catalog(&changed, CatalogTrustPurpose::Baseline, now)
            .is_err());
    }
    #[test]
    fn root_signature_domain_and_generation_floor_cannot_be_bypassed() {
        let payload = document(2, vec![key(19, "a")]);
        let root = ed25519_dalek::SigningKey::from_bytes(&[97; 32])
            .verifying_key()
            .to_bytes();
        assert!(verify_registry_trust_manifest()
            .bytes(&signed(payload.clone(), 19))
            .root_public_key(&root)
            .root_key_id("offline-root")
            .call()
            .is_err());
        assert!(verify_registry_trust_manifest()
            .bytes(&signed(payload.clone(), 97))
            .root_public_key(&root)
            .root_key_id("offline-root")
            .minimum_generation(3)
            .call()
            .is_err());
        let mut wire: Value = serde_json::from_slice(&signed(payload.clone(), 97)).unwrap();
        wire["signed"]["generation"] = json!(3);
        assert!(verify_registry_trust_manifest()
            .bytes(&serde_json::to_vec(&wire).unwrap())
            .root_public_key(&root)
            .root_key_id("offline-root")
            .call()
            .is_err());
        let current = verify(payload);
        let old = verify(document(1, vec![key(19, "a")]));
        assert!(old.validate_successor(&current).is_err());
        let equivocation = verify(document(2, vec![key(23, "b")]));
        assert!(equivocation.validate_successor(&current).is_err());
    }
    #[test]
    fn revoked_keys_and_retirement_cutoffs_cannot_regain_authority() {
        let mut revoked = document(2, vec![key(23, "b")]);
        revoked["revoked_key_ids"] = json!(["a"]);
        let revoked = verify(revoked);
        assert!(verify(document(3, vec![key(19, "a"), key(23, "b")]))
            .validate_successor(&revoked)
            .is_err());
        let mut retired = key(19, "a");
        retired["retired_at"] = json!("2026-10-10T00:00:00Z");
        let retired = verify(document(2, vec![retired, key(23, "b")]));
        assert!(verify(document(3, vec![key(19, "a"), key(23, "b")]))
            .validate_successor(&retired)
            .is_err());
        assert!(verify(document(3, vec![key(22, "a"), key(23, "b")]))
            .validate_successor(&retired)
            .is_err());
    }
    #[test]
    fn minimum_generation_zero_is_not_a_valid_floor() {
        let bytes = signed(document(1, vec![key(23, "current-b")]), 97);
        let root = ed25519_dalek::SigningKey::from_bytes(&[97; 32])
            .verifying_key()
            .to_bytes();
        assert!(verify_registry_trust_manifest()
            .bytes(&bytes)
            .root_public_key(&root)
            .root_key_id("offline-root")
            .minimum_generation(0)
            .call()
            .is_err());
    }
    #[test]
    fn weak_duplicate_and_root_as_metadata_keys_fail_closed() {
        for keys in [
            vec![key(19, "a"), key(23, "a")],
            vec![key(97, "root-delegated")],
        ] {
            let root = ed25519_dalek::SigningKey::from_bytes(&[97; 32])
                .verifying_key()
                .to_bytes();
            assert!(verify_registry_trust_manifest()
                .bytes(&signed(document(1, keys), 97))
                .root_public_key(&root)
                .root_key_id("offline-root")
                .call()
                .is_err());
        }
    }
}
