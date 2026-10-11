//! Shared registry trust generation semantics, independent of executable provider behavior.
use super::*;
use cadencr_registry_core::{CatalogTrustPurpose, VerifiedRegistryTrust};
use serde_json::Value;

impl ManagedTrustStore {
    pub(crate) fn generation(&self) -> Option<u64> {
        self.profile.as_ref().map(|profile| profile.generation())
    }
    pub fn from_registry_trust(profile: VerifiedRegistryTrust) -> Result<Self, ManagedTrustError> {
        let keys = profile
            .envelope()
            .signed
            .keys
            .iter()
            .map(|key| TrustedIndexKey::from_base64(&key.key_id, &key.public_key_base64))
            .collect::<Result<Vec<_>, _>>()?;
        let mut store = Self::new(keys);
        store.profile = Some(std::sync::Arc::new(profile));
        Ok(store)
    }
    pub(crate) fn authenticate_catalog_baseline(
        &self,
        envelope: &Value,
    ) -> Result<Vec<u8>, ManagedTrustError> {
        match &self.profile {
            Some(profile) => profile
                .verify_catalog(envelope, CatalogTrustPurpose::Baseline, chrono::Utc::now())
                .map_err(trust_error),
            None => {
                let index: SignedProviderCatalog = serde_json::from_value(envelope.clone())
                    .map_err(|e| trust_error(e.to_string()))?;
                self.verify_index(index)
                    .map(|index| index.signing_bytes().to_vec())
            }
        }
    }
    pub(crate) fn authenticate_catalog_history(
        &self,
        envelope: &Value,
    ) -> Result<(), ManagedTrustError> {
        match &self.profile {
            Some(profile) => profile
                .verify_catalog(
                    envelope,
                    CatalogTrustPurpose::Historical,
                    chrono::Utc::now(),
                )
                .map(|_| ())
                .map_err(trust_error),
            None => self.authenticate_catalog_baseline(envelope).map(|_| ()),
        }
    }
    pub(crate) fn authenticate_theme_policy_baseline(
        &self,
        envelope: &Value,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), ManagedTrustError> {
        match &self.profile {
            Some(profile) => profile
                .verify_theme_policy_baseline(envelope, now)
                .map_err(trust_error),
            None => self.verify_policy_legacy(envelope),
        }
    }
    pub(crate) fn authenticate_provider_policy_baseline(
        &self,
        envelope: &Value,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), ManagedTrustError> {
        let policy: super::super::blocklist::SignedManagedProviderBlocklist =
            serde_json::from_value(envelope.clone()).map_err(trust_error)?;
        policy
            .signed
            .validate(policy.signed.generated_at)
            .map_err(trust_error)?;
        match &self.profile {
            Some(profile) => profile
                .verify_provider_policy_baseline(envelope, now)
                .map_err(trust_error),
            None => self.verify_policy_legacy(envelope),
        }
    }
    fn verify_policy_legacy(&self, envelope: &Value) -> Result<(), ManagedTrustError> {
        let signature: ManagedIndexSignature =
            serde_json::from_value(envelope["signature"].clone()).map_err(trust_error)?;
        self.verify_bytes(
            &cadencr_registry_core::canonical_json_bytes(&envelope["signed"]),
            &signature,
        )
        .map(|_| ())
    }
    pub(crate) fn verify_index_historical(
        &self,
        envelope: impl Into<SignedProviderCatalog>,
    ) -> Result<VerifiedManagedProviderIndex, ManagedTrustError> {
        let envelope = envelope.into();
        if self.profile.is_none() {
            return self.verify_index(envelope);
        }
        self.authenticate_catalog_history(
            &serde_json::to_value(&envelope).map_err(|e| trust_error(e.to_string()))?,
        )?;
        let mut historical = self.clone();
        historical.profile = None;
        historical.verify_index(envelope)
    }
}

fn trust_error(error: impl fmt::Display) -> ManagedTrustError {
    ManagedTrustError::new(ManagedTrustErrorCode::InvalidSignature, error.to_string())
}

#[cfg(test)]
impl ManagedTrustStore {
    /// Synthetic offline-root profile shared by service migration regressions only.
    pub(crate) fn test_registry_rotation(
        retired_at: chrono::DateTime<chrono::Utc>,
        revoked: bool,
        recovery: Vec<String>,
    ) -> Self {
        Self::test_registry_policy_rotation(retired_at, revoked, recovery, vec![])
    }

    pub(crate) fn test_registry_policy_rotation(
        retired_at: chrono::DateTime<chrono::Utc>,
        revoked: bool,
        recovery: Vec<String>,
        policy_recovery: Vec<String>,
    ) -> Self {
        use base64::Engine as _;
        use ed25519_dalek::{Signer as _, SigningKey};
        use serde_json::json;
        let public = |seed| {
            base64::engine::general_purpose::STANDARD.encode(
                SigningKey::from_bytes(&[seed; 32])
                    .verifying_key()
                    .to_bytes(),
            )
        };
        let mut keys = vec![json!({"key_id":"current-b", "public_key_base64":public(42)})];
        if !revoked {
            keys.push(json!({"key_id":"catalog-test", "public_key_base64":public(41), "retired_at":retired_at.to_rfc3339()}));
        }
        let mut signed = json!({"schema_version":1,"kind":"registry-trust","generation":2,"keys":keys,"revoked_key_ids":if revoked {vec!["catalog-test"]} else {vec![]},"recovery_catalog_sha256":recovery});
        if !policy_recovery.is_empty() {
            signed["recovery_provider_policy_sha256"] = json!(policy_recovery);
        }
        let root = SigningKey::from_bytes(&[99; 32]);
        let bytes = [
            b"cadencr.registry.trust.v1\0".as_slice(),
            cadencr_registry_core::canonical_json_bytes(&signed).as_slice(),
        ]
        .concat();
        let envelope = json!({"signed":signed,"signature":{"algorithm":"ed25519","key_id":"offline-root","value":base64::engine::general_purpose::STANDARD.encode(root.sign(&bytes).to_bytes())}});
        Self::from_registry_trust(
            cadencr_registry_core::verify_registry_trust_manifest()
                .bytes(&serde_json::to_vec(&envelope).unwrap())
                .root_public_key(root.verifying_key().as_bytes())
                .root_key_id("offline-root")
                .call()
                .unwrap(),
        )
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use ed25519_dalek::{Signer as _, SigningKey};

    fn old_catalog(now: chrono::DateTime<chrono::Utc>) -> SignedManagedProviderIndex {
        let mut value: SignedManagedProviderIndex = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        value.signed.generated_at = now - Duration::minutes(2);
        value.signed.expires_at = now + Duration::hours(1);
        value.signature.key_id = "catalog-test".into();
        value.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&value.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        value
    }

    #[test]
    fn retired_catalog_key_is_receipt_history_only_never_fresh_metadata() {
        let now = chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp(), 0).unwrap();
        let store =
            ManagedTrustStore::test_registry_rotation(now - Duration::minutes(1), false, vec![]);
        let prior = old_catalog(now);
        assert!(store.verify_index(prior.clone()).is_err());
        store.verify_index_historical(prior.clone()).unwrap();
        assert!(store
            .authenticate_catalog_baseline(&serde_json::to_value(&prior).unwrap())
            .is_ok());
        let mut after_cutoff = prior;
        after_cutoff.signed.generated_at = now;
        after_cutoff.signature.value = base64::engine::general_purpose::STANDARD.encode(
            SigningKey::from_bytes(&[41; 32])
                .sign(&after_cutoff.signed.signing_bytes().unwrap())
                .to_bytes(),
        );
        assert!(store.verify_index_historical(after_cutoff).is_err());
    }

    #[test]
    fn compromise_checkpoint_can_migrate_catalog_but_never_authenticate_provider_receipt() {
        let now = chrono::DateTime::from_timestamp(chrono::Utc::now().timestamp(), 0).unwrap();
        let prior = old_catalog(now);
        let envelope = serde_json::to_value(&prior).unwrap();
        let digest = VerifiedRegistryTrust::catalog_digest(&envelope);
        let store = ManagedTrustStore::test_registry_rotation(now, true, vec![digest]);
        store.authenticate_catalog_baseline(&envelope).unwrap();
        assert!(store.authenticate_catalog_history(&envelope).is_err());
        assert!(store.verify_index_historical(prior.clone()).is_err());
        assert!(store.verify_index(prior).is_err());
        let mut changed = envelope;
        changed["signed"]["packages"][0]["agent"]["description"] = "compromised alteration".into();
        assert!(store.authenticate_catalog_baseline(&changed).is_err());
    }
}
