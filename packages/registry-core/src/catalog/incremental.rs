use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::package::identity;
use crate::signing::{parse_public_key, verify_envelope_at};
use crate::{PreparedSigningPayload, RegistryError};

/// Authenticate the previous publication snapshot, including expired snapshots.
/// Expiration permits renewal, never bypasses schema, identity or signature checks.
#[bon::builder]
pub fn verify_publication_baseline(
    previous_bytes: &[u8],
    public_key_bytes: &[u8],
    key_id: &str,
) -> Result<Vec<Value>, RegistryError> {
    let baseline = verified_baseline(previous_bytes, public_key_bytes, key_id)?;
    Ok(baseline["signed"]["packages"]
        .as_array()
        .expect("verified packages")
        .clone())
}

/// Merge a bounded publication delta into an authenticated immutable history.
/// An empty delta renews validity without redistributing existing packages.
#[bon::builder]
pub fn prepare_incremental_publication_index(
    previous_bytes: Option<&[u8]>,
    public_key_bytes: &[u8],
    key_id: &str,
    packages: Vec<Value>,
    generated_at: &str,
    expires_at: &str,
) -> Result<PreparedSigningPayload, RegistryError> {
    let Some(bytes) = previous_bytes else {
        crate::validate_signing_key_id(key_id)?;
        parse_public_key(public_key_bytes)?;
        return super::prepare_publication_index()
            .packages(packages)
            .generated_at(generated_at)
            .expires_at(expires_at)
            .call();
    };
    let baseline = verified_baseline(bytes, public_key_bytes, key_id)?;
    let mut merged = baseline["signed"]["packages"]
        .as_array()
        .expect("verified packages")
        .clone();
    let positions = merged
        .iter()
        .enumerate()
        .map(|(position, value)| (package_key(value).expect("verified identity"), position))
        .collect::<HashMap<_, _>>();
    let mut delta = HashSet::new();
    for package in packages {
        let key = package_key(&package)?;
        if !delta.insert(key.clone()) {
            return Err(RegistryError::single(
                "duplicate id@version in publication delta",
            ));
        }
        if let Some(position) = positions.get(&key) {
            if merged[*position] != package {
                return Err(RegistryError::single(format!(
                    "catalog mutates previous package {}@{}",
                    key.0, key.1
                )));
            }
        } else {
            merged.push(package);
        }
    }
    let prepared = super::prepare_publication_index()
        .packages(merged)
        .generated_at(generated_at)
        .expires_at(expires_at)
        .call()?;
    let candidate = crate::parse_json_bytes(prepared.canonical_payload())
        .map_err(|_| RegistryError::single("prepared publication index is invalid"))?;
    crate::snapshot::continuity::validate_continuity(&baseline["signed"], &candidate)?;
    Ok(prepared)
}

fn package_key(package: &Value) -> Result<(String, String), RegistryError> {
    identity(package)
        .map(|(id, version)| (id.to_owned(), version.to_owned()))
        .ok_or_else(|| RegistryError::single("publication package identity is invalid"))
}

fn verified_baseline(bytes: &[u8], key: &[u8], key_id: &str) -> Result<Value, RegistryError> {
    if bytes.len() > crate::MAX_CATALOG_BYTES || key.len() > 16 * 1024 {
        return Err(RegistryError::single(
            "publication baseline or key exceeds input limits",
        ));
    }
    crate::validate_signing_key_id(key_id)?;
    let key = parse_public_key(key)?;
    let baseline = crate::parse_json_bytes(bytes)
        .map_err(|_| RegistryError::single("previous index must be valid JSON"))?;
    verify_envelope_at(&baseline, &key, key_id, true, chrono::Utc::now())?;
    super::validate_catalog_identities(
        baseline["signed"]["packages"]
            .as_array()
            .expect("verified packages"),
    )?;
    Ok(baseline)
}

#[cfg(test)]
mod tests {
    use base64::prelude::{Engine as _, BASE64_STANDARD};
    use chrono::{Duration, SecondsFormat, Utc};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    fn package(version: &str) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        value["agent"]["version"] = json!(version);
        value
    }

    fn window(minutes: i64) -> (String, String) {
        let generated = Utc::now() - Duration::minutes(minutes);
        (
            generated.to_rfc3339_opts(SecondsFormat::Secs, true),
            (generated + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
        )
    }

    fn baseline(packages: Vec<Value>) -> (Vec<u8>, Vec<u8>) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let (generated, expires) = window(3);
        let prepared = super::super::prepare_publication_index()
            .packages(packages)
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
            .unwrap();
        let signature = key.sign(prepared.canonical_payload());
        let signed: Value = serde_json::from_slice(prepared.canonical_payload()).unwrap();
        let envelope = json!({"signed":signed,"signature":{
            "algorithm":"ed25519", "key_id":"test-key", "value":BASE64_STANDARD.encode(signature.to_bytes())
        }});
        let mut der = b"\x30\x2a\x30\x05\x06\x03\x2b\x65\x70\x03\x21\x00".to_vec();
        der.extend_from_slice(key.verifying_key().as_bytes());
        let public =
            pem_rfc7468::encode_string("PUBLIC KEY", pem_rfc7468::LineEnding::LF, &der).unwrap();
        (serde_json::to_vec(&envelope).unwrap(), public.into_bytes())
    }

    fn prepare(
        bytes: &[u8],
        key: &[u8],
        packages: Vec<Value>,
    ) -> Result<PreparedSigningPayload, RegistryError> {
        let (generated, expires) = window(1);
        prepare_incremental_publication_index()
            .previous_bytes(bytes)
            .public_key_bytes(key)
            .key_id("test-key")
            .packages(packages)
            .generated_at(&generated)
            .expires_at(&expires)
            .call()
    }

    #[test]
    fn grows_past_one_hundred_versions_and_renews_without_delta() {
        let history = (1..=120)
            .map(|patch| {
                let mut value = package(&format!("1.0.{patch}"));
                value["agent"]["description"] = "x".repeat(10_000).into();
                value
            })
            .collect::<Vec<_>>();
        let (bytes, key) = baseline(history.clone());
        assert!(bytes.len() > 1024 * 1024);
        let prepared = prepare(&bytes, &key, vec![package("2.0.0")]).unwrap();
        let value: Value = serde_json::from_slice(prepared.canonical_payload()).unwrap();
        assert_eq!(value["packages"].as_array().unwrap().len(), 121);
        assert_eq!(value["packages"][0], history[0]);
        let renewed = prepare(&bytes, &key, vec![]).unwrap();
        let value: Value = serde_json::from_slice(renewed.canonical_payload()).unwrap();
        assert_eq!(value["packages"], json!(history));
    }

    #[test]
    fn rejects_tampering_mutation_duplicate_delta_and_owner_changes() {
        let original = package("1.0.0");
        let (bytes, key) = baseline(vec![original.clone()]);
        assert!(prepare(&bytes, &key, vec![original.clone()]).is_ok());
        let mut changed = original.clone();
        changed["agent"]["name"] = json!("changed");
        assert!(prepare(&bytes, &key, vec![changed])
            .unwrap_err()
            .to_string()
            .contains("mutates"));
        assert!(prepare(&bytes, &key, vec![original.clone(), original]).is_err());
        let mut owned = package("2.0.0");
        owned["host"]["publisher"] = json!("other");
        assert!(prepare(&bytes, &key, vec![owned]).is_err());
        let mut tampered: Value = serde_json::from_slice(&bytes).unwrap();
        tampered["signed"]["packages"][0]["agent"]["name"] = json!("tampered");
        assert!(prepare(&serde_json::to_vec(&tampered).unwrap(), &key, vec![]).is_err());
        assert!(verify_publication_baseline()
            .previous_bytes(&bytes)
            .public_key_bytes(&key)
            .key_id("different-key")
            .call()
            .is_err());
    }
}
