use super::*;
use crate::domain::themes::managed::models::SignedMixedCatalog;

impl ManagedTrustStore {
    pub(super) fn verify_mixed(
        &self,
        index: SignedMixedCatalog,
    ) -> Result<VerifiedManagedProviderIndex, ManagedTrustError> {
        let invalid = |message: String| {
            ManagedTrustError::new(ManagedTrustErrorCode::InvalidSignedPayload, message)
        };
        let original = serde_json::to_value(&index.signed).map_err(|e| invalid(e.to_string()))?;
        let canonical = cadencr_registry_core::canonical_json_bytes(&original);
        if canonical.len() > cadencr_registry_core::MAX_CATALOG_BYTES {
            return Err(invalid("mixed catalog exceeds size budget".into()));
        }
        // Authenticate the whole original mixed payload before interpreting entries.
        let signer_key_id = self.verify_bytes(&canonical, &index.signature)?;
        if index.signed.schema_version != 2 {
            return Err(invalid("mixed catalog schema must equal 2".into()));
        }
        cadencr_registry_core::validate_signing_payload_at(&original, true, chrono::Utc::now())
            .map_err(|e| invalid(e.to_string()))?;
        let envelope = SignedProviderCatalog::Mixed(index);
        let signed = envelope.provider_view().map_err(invalid)?;
        for package in &signed.packages {
            package
                .validate_contract()
                .map_err(|e| invalid(e.to_string()))?;
        }
        Ok(VerifiedManagedProviderIndex {
            envelope,
            provider_view: signed,
            signer_key_id,
            signing_bytes: canonical,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat, Utc};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::{json, Value};

    fn sign(index: &mut SignedMixedCatalog) {
        let bytes = cadencr_registry_core::canonical_json_bytes(
            &serde_json::to_value(&index.signed).unwrap(),
        );
        index.signature.value = base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&[51; 32]).sign(&bytes).to_bytes());
    }
    fn fixture(providers: bool) -> (ManagedTrustStore, SignedMixedCatalog) {
        let legacy: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        let provider = legacy["signed"]["packages"][0].clone();
        let theme = json!({"kind":"theme","package":{"theme":{"id":"midnight","name":"Midnight","description":"Dark theme","version":"1.0.0","repository":"https://github.com/acme/themes","license":"MIT","document_version":1,"distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz","sha256":"a".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.12.0"}}}});
        let now = Utc::now() - Duration::minutes(1);
        let mut packages = Vec::new();
        if providers {
            packages.push(json!({"kind":"provider","package":provider}));
        }
        packages.push(theme);
        let value = json!({"signed":{"schema_version":2,"generated_at":now.to_rfc3339_opts(SecondsFormat::Secs,true),"expires_at":(now+Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs,true),"packages":packages},"signature":{"algorithm":"ed25519","key_id":"mixed-test","value":""}});
        let mut index: SignedMixedCatalog = serde_json::from_value(value).unwrap();
        sign(&mut index);
        let trust = ManagedTrustStore::new([TrustedIndexKey::new(
            "mixed-test",
            SigningKey::from_bytes(&[51; 32]).verifying_key().to_bytes(),
        )
        .unwrap()]);
        (trust, index)
    }
    #[test]
    fn verifies_entire_mixed_payload_then_resolves_provider_without_rewriting_proof() {
        let (trust, index) = fixture(true);
        let original = cadencr_registry_core::canonical_json_bytes(
            &serde_json::to_value(&index.signed).unwrap(),
        );
        let wire = serde_json::to_value(&index).unwrap();
        let verified = trust.verify_index(index).unwrap();
        assert_eq!(verified.signing_bytes(), original);
        assert_eq!(serde_json::to_value(verified.envelope()).unwrap(), wire);
        assert_eq!(verified.index().packages.len(), 1);
        assert_eq!(
            verified
                .resolve_current_platform("acme-agent", "1.2.3", "0.12.0")
                .unwrap()
                .provider_id,
            "acme-agent"
        );
    }
    #[test]
    fn themes_only_is_a_verified_empty_provider_view_not_a_fake_provider() {
        let (trust, index) = fixture(false);
        let verified = trust.verify_index(index).unwrap();
        assert!(verified.index().packages.is_empty());
        assert_eq!(
            verified
                .resolve_current_platform("midnight", "1.0.0", "0.12.0")
                .unwrap_err()
                .code,
            super::super::super::ManagedContractErrorCode::PackageNotFound
        );
    }
    #[test]
    fn keys_tampering_closed_theme_fields_and_schema_fallback_fail_closed() {
        let (trust, index) = fixture(true);
        let mut tampered = index.clone();
        tampered.signed.packages[1]["package"]["theme"]["name"] = json!("Changed");
        assert_eq!(
            trust.verify_index(tampered).unwrap_err().code,
            ManagedTrustErrorCode::InvalidSignature
        );
        let mut unknown = index.clone();
        unknown.signature.key_id = "untrusted".into();
        assert_eq!(
            trust.verify_index(unknown).unwrap_err().code,
            ManagedTrustErrorCode::UnknownSigningKey
        );
        assert_eq!(
            ManagedTrustStore::default()
                .verify_index(index.clone())
                .unwrap_err()
                .code,
            ManagedTrustErrorCode::TrustNotConfigured
        );
        let mut invalid = index.clone();
        invalid.signed.packages[1]["package"]["theme"]["distribution"]["cmd"] = json!("evil");
        sign(&mut invalid);
        assert_eq!(
            trust.verify_index(invalid).unwrap_err().code,
            ManagedTrustErrorCode::InvalidSignedPayload
        );
        let mut fallback = index;
        fallback.signed.schema_version = 1;
        sign(&mut fallback);
        let wire: SignedProviderCatalog =
            serde_json::from_value(serde_json::to_value(fallback).unwrap()).unwrap();
        assert_eq!(
            trust.verify_index(wire).unwrap_err().code,
            ManagedTrustErrorCode::InvalidSignedPayload
        );
    }
}
