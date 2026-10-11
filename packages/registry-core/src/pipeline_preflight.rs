//! Unsigned protected-pipeline policy checks. This module never creates signatures.
use std::path::Path;

use serde_json::Value;

use crate::signing::{parse_public_key, verify_envelope_at};
use crate::{PreparedSigningPayload, RegistryError};

/// Check the pinned key pair and signed baseline against an unsigned candidate.
/// Returns the immutable package identities that must already be published.
#[bon::builder]
pub fn preflight_publication_pipeline(
    payload: &PreparedSigningPayload,
    previous_bytes: Option<&[u8]>,
    public_key_bytes: &[u8],
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<String>, RegistryError> {
    crate::validate_signing_key_id(key_id)?;
    let public = parse_public_key(public_key_bytes)?;
    let private = crate::signing::read_signing_key(private_key_file)?;
    if private.verifying_key() != public {
        return Err(RegistryError::single(
            "private key does not match pinned public key",
        ));
    }
    let Some(bytes) = previous_bytes else {
        return Ok(Vec::new());
    };
    let prior = crate::parse_json_bytes(bytes)
        .map_err(|_| RegistryError::single("previous index must be valid JSON"))?;
    verify_envelope_at(&prior, &public, key_id, true, chrono::Utc::now())?;
    let candidate = crate::parse_json_bytes(payload.canonical_payload())
        .map_err(|_| RegistryError::single("prepared payload is invalid"))?;
    crate::snapshot::continuity::validate_continuity(&prior["signed"], &candidate)?;
    Ok(prior["signed"]["packages"]
        .as_array()
        .expect("verified packages")
        .iter()
        .map(identity)
        .collect())
}

fn identity(package: &Value) -> String {
    format!(
        "{}@{}",
        package["agent"]["id"].as_str().expect("verified id"),
        package["agent"]["version"]
            .as_str()
            .expect("verified version")
    )
}

/// Sign verified publication bytes only with the exact pinned public-key identity.
/// The comparison and signature use the same in-memory private key.
#[bon::builder]
pub fn sign_prepared_index_pinned(
    payload: PreparedSigningPayload,
    private_key_file: &Path,
    public_key_bytes: &[u8],
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    crate::validate_signing_key_id(key_id)?;
    let (generated_at, expires_at) = payload.window();
    crate::index::validate_fresh_window(generated_at, expires_at, chrono::Utc::now())?;
    let pinned = parse_public_key(public_key_bytes)?;
    crate::signing::sign_canonical_payload(
        payload.canonical_payload(),
        private_key_file,
        key_id,
        Some(&pinned),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat, Utc};
    const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
    const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";

    fn payload(generated: &str, package: Value) -> PreparedSigningPayload {
        crate::prepare_publication_index()
            .packages(vec![package])
            .generated_at(generated)
            .expires_at(
                &(Utc::now() + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
            )
            .call()
            .unwrap()
    }

    #[test]
    fn unsigned_preflight_enforces_baseline_continuity_and_actual_signer_pins_the_key() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private.pem");
        std::fs::write(&private, PRIVATE).unwrap();
        let package: Value = serde_json::from_str(include_str!(
            "../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        let old = (Utc::now() - Duration::minutes(2)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let next = (Utc::now() - Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let baseline =
            crate::sign_prepared_index(payload(&old, package.clone()), &private, "test-key")
                .unwrap();
        let required = preflight_publication_pipeline()
            .payload(&payload(&next, package.clone()))
            .previous_bytes(&baseline)
            .public_key_bytes(PUBLIC.as_bytes())
            .private_key_file(&private)
            .key_id("test-key")
            .call()
            .unwrap();
        assert_eq!(required.len(), 1);
        let mut changed = package.clone();
        changed["agent"]["name"] = "mutated".into();
        assert!(preflight_publication_pipeline()
            .payload(&payload(&next, changed))
            .previous_bytes(&baseline)
            .public_key_bytes(PUBLIC.as_bytes())
            .private_key_file(&private)
            .key_id("test-key")
            .call()
            .unwrap_err()
            .to_string()
            .contains("mutates"));
        let signed = sign_prepared_index_pinned()
            .payload(payload(&next, package.clone()))
            .private_key_file(&private)
            .public_key_bytes(PUBLIC.as_bytes())
            .key_id("test-key")
            .call()
            .unwrap();
        assert!(!signed.is_empty());
        // A valid, different Ed25519 key is not allowed at signature time.
        let mut der = pem_rfc7468::decode_vec(PRIVATE.as_bytes()).unwrap().1;
        let seed_offset = der.len() - 32;
        der[seed_offset..].fill(8);
        let pem =
            pem_rfc7468::encode_string("PRIVATE KEY", pem_rfc7468::LineEnding::LF, &der).unwrap();
        std::fs::write(&private, pem).unwrap();
        assert!(sign_prepared_index_pinned()
            .payload(payload(&next, package))
            .private_key_file(&private)
            .public_key_bytes(PUBLIC.as_bytes())
            .key_id("test-key")
            .call()
            .unwrap_err()
            .to_string()
            .contains("pinned public key"));
    }
}
