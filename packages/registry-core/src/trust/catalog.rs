use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::{invalid, VerifiedRegistryTrust};

#[derive(Clone, Copy)]
pub enum CatalogTrustPurpose {
    Current,
    Historical,
    /// Only continuity/renewal may use an offline-root recovery checkpoint.
    Baseline,
}

impl VerifiedRegistryTrust {
    pub fn verify_catalog(
        &self,
        envelope: &Value,
        purpose: CatalogTrustPurpose,
        now: DateTime<Utc>,
    ) -> Result<Vec<u8>, crate::RegistryError> {
        let allow_expired = !matches!(purpose, CatalogTrustPurpose::Current);
        let checkpoints = &self.envelope.signed.recovery_catalog_sha256;
        if matches!(purpose, CatalogTrustPurpose::Baseline)
            && !checkpoints.is_empty()
            && checkpoints.contains(&Self::catalog_digest(envelope))
        {
            return crate::validate_signing_payload_at(&envelope["signed"], allow_expired, now);
        }
        let id = envelope["signature"]["key_id"].as_str().unwrap_or("");
        let (key, retired_at) = self
            .keys
            .get(id)
            .ok_or_else(|| invalid("unknown or revoked catalog key"))?;
        if let Some(retired_at) = retired_at {
            if matches!(purpose, CatalogTrustPurpose::Current) {
                return Err(invalid("retired key cannot authenticate a current catalog"));
            }
            let generated = DateTime::parse_from_rfc3339(
                envelope["signed"]["generated_at"].as_str().unwrap_or(""),
            )
            .map_err(|_| invalid("catalog generated_at is invalid"))?;
            if generated.with_timezone(&Utc) >= *retired_at {
                return Err(invalid(
                    "historical catalog was generated after key retirement",
                ));
            }
        }
        crate::signing::verify_envelope_at(envelope, key, id, allow_expired, now)
    }

    pub fn catalog_digest(envelope: &Value) -> String {
        let digest = Sha256::digest(crate::canonical_json_bytes(envelope));
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
