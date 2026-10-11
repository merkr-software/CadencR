//! Policy high-water authentication only. Recovery checkpoints never grant current authority.
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{invalid, VerifiedRegistryTrust};

impl VerifiedRegistryTrust {
    pub fn verify_theme_policy_baseline(
        &self,
        envelope: &Value,
        now: DateTime<Utc>,
    ) -> Result<(), crate::RegistryError> {
        let prepared = crate::prepare_theme_blocklist(&envelope["signed"], true, now)?;
        self.verify_policy_baseline(
            envelope,
            prepared.signing.canonical_payload(),
            &self.envelope.signed.recovery_theme_policy_sha256,
            now,
        )
    }
    /// Callers also validate provider-policy entry semantics before using this baseline.
    pub fn verify_provider_policy_baseline(
        &self,
        envelope: &Value,
        now: DateTime<Utc>,
    ) -> Result<(), crate::RegistryError> {
        let signed = envelope["signed"]
            .as_object()
            .ok_or_else(|| invalid("provider policy must be an object"))?;
        if signed.len() != 4
            || signed.get("schema_version").and_then(Value::as_u64) != Some(1)
            || !signed.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "schema_version" | "generated_at" | "expires_at" | "entries"
                )
            })
            || !signed["entries"].as_array().is_some_and(|entries| {
                entries.iter().all(|entry| {
                    entry.as_object().is_some_and(|fields| {
                        fields.contains_key("provider_id")
                            && fields.keys().all(|key| {
                                matches!(
                                    key.as_str(),
                                    "provider_id"
                                        | "version_requirement"
                                        | "archive_sha256"
                                        | "reason"
                                )
                            })
                    })
                })
            })
        {
            return Err(invalid("provider policy namespace or shape is invalid"));
        }
        self.verify_policy_baseline(
            envelope,
            &crate::canonical_json_bytes(&envelope["signed"]),
            &self.envelope.signed.recovery_provider_policy_sha256,
            now,
        )
    }
    fn verify_policy_baseline(
        &self,
        envelope: &Value,
        payload: &[u8],
        checkpoints: &[String],
        now: DateTime<Utc>,
    ) -> Result<(), crate::RegistryError> {
        let object = envelope
            .as_object()
            .ok_or_else(|| invalid("policy envelope must be an object"))?;
        if object.len() != 2 || !object.contains_key("signed") || !object.contains_key("signature")
        {
            return Err(invalid("policy envelope has unknown or missing fields"));
        }
        let generated = timestamp(envelope, "generated_at")?;
        if generated > now || timestamp(envelope, "expires_at")? <= generated {
            return Err(invalid("policy publication window is invalid"));
        }
        let signature = crate::signing::validate_signature(envelope["signature"].as_object())?;
        let id = signature_id(envelope)?;
        crate::validate_signing_key_id(id)?;
        if !checkpoints.is_empty() && checkpoints.contains(&Self::catalog_digest(envelope)) {
            return Ok(());
        }
        let (key, retired) = self
            .keys
            .get(id)
            .ok_or_else(|| invalid("unknown or revoked policy key"))?;
        if retired.is_some_and(|cutoff| generated >= cutoff) {
            return Err(invalid("policy was generated after signing key retirement"));
        }
        key.verify_strict(payload, &signature)
            .map_err(|_| invalid("policy signature verification failed"))
    }
}
fn timestamp(envelope: &Value, field: &str) -> Result<DateTime<Utc>, crate::RegistryError> {
    DateTime::parse_from_rfc3339(envelope["signed"][field].as_str().unwrap_or_default())
        .map(|at| at.with_timezone(&Utc))
        .map_err(|_| invalid("policy timestamp is invalid"))
}

fn signature_id(envelope: &Value) -> Result<&str, crate::RegistryError> {
    envelope["signature"]["key_id"]
        .as_str()
        .ok_or_else(|| invalid("policy signing key id is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::prelude::{Engine as _, BASE64_STANDARD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    fn policy(now: DateTime<Utc>) -> Value {
        let signed = json!({"schema_version":1,"kind":"theme-blocklist","generated_at":(now-chrono::Duration::minutes(3)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"expires_at":(now+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),"entries":[]});
        json!({"signed":signed,"signature":{"algorithm":"ed25519","key_id":"a","value":BASE64_STANDARD.encode(SigningKey::from_bytes(&[19;32]).sign(&crate::canonical_json_bytes(&signed)).to_bytes())}})
    }
    fn trust(
        now: DateTime<Utc>,
        revoked: bool,
        namespace: &str,
        hashes: Vec<String>,
    ) -> VerifiedRegistryTrust {
        let mut keys = vec![
            json!({"key_id":"b","public_key_base64":BASE64_STANDARD.encode(SigningKey::from_bytes(&[23;32]).verifying_key().to_bytes())}),
        ];
        if !revoked {
            keys.push(json!({"key_id":"a","public_key_base64":BASE64_STANDARD.encode(SigningKey::from_bytes(&[19;32]).verifying_key().to_bytes()),"retired_at":(now-chrono::Duration::minutes(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)}));
        }
        let mut payload = json!({"schema_version":1,"kind":"registry-trust","generation":2,"keys":keys,"revoked_key_ids":if revoked {vec!["a"]} else {vec![]},"recovery_catalog_sha256":[]});
        if !hashes.is_empty() {
            payload[namespace] = json!(hashes);
        }
        let root = SigningKey::from_bytes(&[99; 32]);
        let signing = [
            super::super::DOMAIN,
            crate::canonical_json_bytes(&payload).as_slice(),
        ]
        .concat();
        let envelope = json!({"signed":payload,"signature":{"algorithm":"ed25519","key_id":"root","value":BASE64_STANDARD.encode(root.sign(&signing).to_bytes())}});
        crate::verify_registry_trust_manifest()
            .bytes(&serde_json::to_vec(&envelope).unwrap())
            .root_public_key(root.verifying_key().as_bytes())
            .root_key_id("root")
            .call()
            .unwrap()
    }
    #[test]
    fn policy_baselines_are_retirement_bounded_scoped_and_never_current_authority() {
        let now = Utc::now();
        let old = policy(now);
        let ordinary = trust(now, false, "recovery_theme_policy_sha256", vec![]);
        ordinary.verify_theme_policy_baseline(&old, now).unwrap();
        assert!(ordinary.active_key("a").is_err());
        let late = policy(now + chrono::Duration::minutes(3));
        assert!(ordinary
            .verify_theme_policy_baseline(&late, now + chrono::Duration::minutes(3))
            .is_err());
        let digest = VerifiedRegistryTrust::catalog_digest(&old);
        let wrong = trust(
            now,
            true,
            "recovery_provider_policy_sha256",
            vec![digest.clone()],
        );
        assert!(wrong.verify_theme_policy_baseline(&old, now).is_err());
        assert!(wrong.verify_provider_policy_baseline(&old, now).is_err());
        let approved = trust(now, true, "recovery_theme_policy_sha256", vec![digest]);
        approved.verify_theme_policy_baseline(&old, now).unwrap();
        assert!(approved.active_key("a").is_err());
        let mut changed = old;
        changed["signed"]["expires_at"] = (now + chrono::Duration::hours(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            .into();
        assert!(approved
            .verify_theme_policy_baseline(&changed, now)
            .is_err());
    }
    #[test]
    fn malformed_signature_fields_never_panic_or_authenticate() {
        let now = Utc::now();
        let mut old = policy(now);
        old["signature"] = json!({"unknown":1,"key_id":"a","value":"bogus"});
        let approved = trust(
            now,
            true,
            "recovery_theme_policy_sha256",
            vec![VerifiedRegistryTrust::catalog_digest(&old)],
        );
        assert!(approved.verify_theme_policy_baseline(&old, now).is_err());
    }
}
