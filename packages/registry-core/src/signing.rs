use std::path::Path;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use chrono::Utc;
use ed25519_dalek::pkcs8::{DecodePrivateKey as _, DecodePublicKey as _};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::error::RegistryError;
use crate::index::{validate_fresh_window, validate_index};
use crate::json::{canonical_json_bytes, parse_json};
use crate::package::valid_identifier;
use crate::safe_io::read_bounded_regular;
use crate::PreparedSigningPayload;

mod payload;
pub use payload::validate_signing_key_id;
pub(crate) use payload::{validate_signing_payload, validate_signing_payload_at};

const DOCUMENT_LIMIT: u64 = 32 * 1024 * 1024;
const KEY_LIMIT: u64 = 16 * 1024;

pub fn sign_index(
    payload_file: &Path,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let signed = read_json(payload_file, DOCUMENT_LIMIT, "payload")?;
    sign_index_payload(&signed, private_key_file, key_id)
}

/// Sign an already prepared in-memory index with JavaScript-compatible number canonicalization.
pub fn sign_index_payload(
    signed: &Value,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let payload = validate_signing_payload(signed, false)?;
    validate_signing_key_id(key_id)?;
    sign_canonical_payload(&payload, private_key_file, key_id)
}

/// Sign a prepared payload without repeating immutable validation or canonicalization.
pub fn sign_prepared_index(
    payload: PreparedSigningPayload,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    sign_prepared_index_at(payload, private_key_file, key_id, Utc::now())
}

fn sign_prepared_index_at(
    payload: PreparedSigningPayload,
    private_key_file: &Path,
    key_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Vec<u8>, RegistryError> {
    validate_signing_key_id(key_id)?;
    let (generated_at, expires_at) = payload.window();
    validate_fresh_window(generated_at, expires_at, now)?;
    sign_canonical_payload(payload.canonical_payload(), private_key_file, key_id)
}

fn sign_canonical_payload(
    payload: &[u8],
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let pem = Zeroizing::new(read_file(private_key_file, KEY_LIMIT, "private key")?);
    let (label, der) = pem_rfc7468::decode_vec(&pem).map_err(|_| private_key_error())?;
    let der = Zeroizing::new(der);
    if label != "PRIVATE KEY" {
        return Err(private_key_error());
    }
    let key = SigningKey::from_pkcs8_der(&der).map_err(|_| private_key_error())?;
    let signature = key.sign(payload);
    key.verifying_key()
        .verify_strict(payload, &signature)
        .map_err(|_| RegistryError::single("signature self-verification failed"))?;
    let signature = json!({
        "algorithm": "ed25519",
        "key_id": key_id,
        "value": BASE64_STANDARD.encode(signature.to_bytes()),
    });
    let signature = canonical_json_bytes(&signature);
    signed_envelope(payload, &signature)
}

fn signed_envelope(payload: &[u8], signature: &[u8]) -> Result<Vec<u8>, RegistryError> {
    let mut envelope = Vec::with_capacity(payload.len() + signature.len() + 26);
    envelope.extend_from_slice(b"{\"signature\":");
    envelope.extend_from_slice(signature);
    envelope.extend_from_slice(b",\"signed\":");
    envelope.extend_from_slice(payload);
    envelope.extend_from_slice(b"}\n");
    if envelope.len() as u64 > DOCUMENT_LIMIT {
        Err(RegistryError::single("signed index exceeds 32 MiB"))
    } else {
        Ok(envelope)
    }
}

pub fn verify_signed_index(
    index_file: &Path,
    public_key_file: &Path,
    key_id: &str,
    allow_expired: bool,
) -> Result<(), RegistryError> {
    validate_signing_key_id(key_id)?;
    let envelope = read_json(index_file, DOCUMENT_LIMIT, "signed index")?;
    let validated = validate_envelope_at(&envelope, allow_expired, Utc::now())?;
    validate_envelope_key_id(&validated, key_id)?;
    let pem = read_file(public_key_file, KEY_LIMIT, "public key")?;
    let key = parse_public_key(&pem)?;
    verify_validated_signature(validated, &key).map(|_| ())
}

pub(crate) fn parse_public_key(bytes: &[u8]) -> Result<VerifyingKey, RegistryError> {
    let (label, der) = pem_rfc7468::decode_vec(bytes).map_err(|_| public_key_error())?;
    if label != "PUBLIC KEY" {
        return Err(public_key_error());
    }
    VerifyingKey::from_public_key_der(&der).map_err(|_| public_key_error())
}

pub(crate) fn verify_envelope_at(
    envelope: &Value,
    key: &VerifyingKey,
    key_id: &str,
    allow_expired: bool,
    now: chrono::DateTime<Utc>,
) -> Result<Vec<u8>, RegistryError> {
    let validated = validate_envelope_at(envelope, allow_expired, now)?;
    validate_envelope_key_id(&validated, key_id)?;
    verify_validated_signature(validated, key)
}

fn validate_envelope_key_id(
    validated: &ValidatedEnvelope<'_>,
    key_id: &str,
) -> Result<(), RegistryError> {
    if validated.signature.get("key_id").and_then(Value::as_str) != Some(key_id) {
        return Err(RegistryError::single(
            "envelope signing key id does not match",
        ));
    }
    Ok(())
}

fn verify_validated_signature(
    validated: ValidatedEnvelope<'_>,
    key: &VerifyingKey,
) -> Result<Vec<u8>, RegistryError> {
    key.verify_strict(&validated.payload, &validated.decoded)
        .map_err(|_| RegistryError::single("envelope signature verification failed"))?;
    Ok(validated.payload)
}

pub fn assemble_signed_index(
    payload_file: &Path,
    signature_file: &Path,
) -> Result<Vec<u8>, RegistryError> {
    let signed = read_json(payload_file, DOCUMENT_LIMIT, "payload")?;
    validate_index(&signed, Utc::now(), false)?;
    let signature = read_json(signature_file, KEY_LIMIT, "signature")?;
    validate_signature(signature.as_object())?;
    let envelope = json!({"signed": signed, "signature": signature});
    Ok(canonical_document(&envelope))
}

struct ValidatedEnvelope<'a> {
    signature: &'a Map<String, Value>,
    decoded: Signature,
    payload: Vec<u8>,
}

fn validate_envelope_at(
    envelope: &Value,
    allow_expired: bool,
    now: chrono::DateTime<Utc>,
) -> Result<ValidatedEnvelope<'_>, RegistryError> {
    let object = envelope
        .as_object()
        .ok_or_else(|| RegistryError::single("signed index must be an object"))?;
    reject_unknown(object, &["signed", "signature"], "envelope")?;
    let signed = object
        .get("signed")
        .ok_or_else(|| RegistryError::single("envelope.signed is required"))?;
    let payload = validate_signing_payload_at(signed, allow_expired, now)?;
    let signature = object.get("signature").and_then(Value::as_object);
    let decoded = validate_signature(signature)?;
    Ok(ValidatedEnvelope {
        signature: signature.expect("validated signature object"),
        decoded,
        payload,
    })
}

fn validate_signature(signature: Option<&Map<String, Value>>) -> Result<Signature, RegistryError> {
    let signature =
        signature.ok_or_else(|| RegistryError::single("envelope.signature must be an object"))?;
    reject_unknown(
        signature,
        &["algorithm", "key_id", "value"],
        "envelope.signature",
    )?;
    if signature.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return Err(RegistryError::single(
            "envelope.signature.algorithm must equal ed25519",
        ));
    }
    let key_id = signature
        .get("key_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !valid_identifier(key_id) {
        return Err(RegistryError::single(
            "envelope.signature.key_id is invalid",
        ));
    }
    decode_signature(signature)
}

fn decode_signature(signature: &Map<String, Value>) -> Result<Signature, RegistryError> {
    let encoded = signature.get("value").and_then(Value::as_str).unwrap_or("");
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| signature_encoding_error())?;
    if bytes.len() != 64 || BASE64_STANDARD.encode(&bytes) != encoded {
        return Err(signature_encoding_error());
    }
    Signature::from_slice(&bytes).map_err(|_| signature_encoding_error())
}

fn reject_unknown(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), RegistryError> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Err(RegistryError::single(format!(
            "{label}.{key} is not allowed"
        )))
    } else {
        Ok(())
    }
}

fn read_json(path: &Path, limit: u64, label: &str) -> Result<Value, RegistryError> {
    let bytes = read_file(path, limit, label)?;
    parse_json(&bytes).map_err(|_| RegistryError::single(format!("{label} must be valid JSON")))
}

fn read_file(path: &Path, limit: u64, label: &str) -> Result<Vec<u8>, RegistryError> {
    read_bounded_regular(path, limit)
        .map_err(|error| RegistryError::single(format!("cannot read {label}: {error}")))
}

fn canonical_document(value: &Value) -> Vec<u8> {
    let mut bytes = canonical_json_bytes(value);
    bytes.push(b'\n');
    bytes
}

fn private_key_error() -> RegistryError {
    RegistryError::single("private key must be an Ed25519 PKCS8 PEM file")
}

fn public_key_error() -> RegistryError {
    RegistryError::single("public key must be an Ed25519 SPKI PEM file")
}

fn signature_encoding_error() -> RegistryError {
    RegistryError::single(
        "envelope.signature.value must be standard padded base64 encoding 64 bytes",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SecondsFormat};

    fn payload() -> Value {
        let generated = Utc::now() - Duration::minutes(1);
        json!({
            "schema_version": 1,
            "generated_at": generated.to_rfc3339_opts(SecondsFormat::Secs, true),
            "expires_at": (generated + Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
            "packages": [{
                "agent": {
                    "id": "alpha", "name": "Alpha", "version": "1.0.0",
                    "description": "test", "distribution": {"binary": {"linux-x86_64": {
                        "archive": "https://example.com/provider.tgz", "cmd": "bin/provider",
                        "sha256": "a".repeat(64)
                    }}}
                },
                "host": {"publisher": "acme", "compatibility": {"min_app_version": "1.0.0"},
                    "assets": {"icon": "icon.png"}}
            }]
        })
    }

    #[test]
    fn signs_an_in_memory_payload_with_the_same_envelope_contract() {
        let directory = tempfile::tempdir().unwrap();
        let key_path = directory.path().join("private.pem");
        // Synthetic fixed test-only key. This is not a release credential.
        std::fs::write(
            &key_path,
            "-----BEGIN PRIVATE KEY-----\n\
             MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n\
             -----END PRIVATE KEY-----\n",
        )
        .unwrap();

        let payload = payload();
        let bytes = sign_index_payload(&payload, &key_path, "release-2026").unwrap();
        let prepared = crate::prepare_publication_index()
            .packages(payload["packages"].as_array().unwrap().clone())
            .generated_at(payload["generated_at"].as_str().unwrap())
            .expires_at(payload["expires_at"].as_str().unwrap())
            .call()
            .unwrap();
        let prepared_bytes = sign_prepared_index(prepared, &key_path, "release-2026").unwrap();
        assert_eq!(prepared_bytes, bytes);
        let envelope: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope["signed"], payload);
        assert_eq!(envelope["signature"]["key_id"], "release-2026");
        assert!(bytes.ends_with(b"\n"));
    }

    #[test]
    fn public_key_id_validation_runs_without_reading_key_material() {
        assert!(validate_signing_key_id("release-2026").is_ok());
        let error = sign_index_payload(
            &payload(),
            Path::new("/definitely/missing/private.pem"),
            "invalid key",
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "signing key id is invalid");
    }

    #[test]
    fn in_memory_unsafe_integers_use_javascript_number_canonicalization() {
        let directory = tempfile::tempdir().unwrap();
        let key_path = directory.path().join("private.pem");
        // Synthetic fixed test-only key. This is not a release credential.
        std::fs::write(
            &key_path,
            "-----BEGIN PRIVATE KEY-----\n\
             MC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n\
             -----END PRIVATE KEY-----\n",
        )
        .unwrap();
        let mut payload = payload();
        payload["packages"][0]["agent"]["future_number"] = json!(9_007_199_254_740_993_u64);

        let bytes = sign_index_payload(&payload, &key_path, "release-2026").unwrap();
        let document = String::from_utf8(bytes).unwrap();
        assert!(document.contains("9007199254740992"));
        assert!(!document.contains("9007199254740993"));
    }

    #[test]
    fn prepared_payload_freshness_is_rechecked_before_key_access() {
        let source = payload();
        let generated_at = source["generated_at"].as_str().unwrap();
        let expires_at = source["expires_at"].as_str().unwrap();
        let prepared = crate::prepare_publication_index()
            .packages(source["packages"].as_array().unwrap().clone())
            .generated_at(generated_at)
            .expires_at(expires_at)
            .call()
            .unwrap();
        let after_expiry = chrono::DateTime::parse_from_rfc3339(expires_at)
            .unwrap()
            .with_timezone(&Utc)
            + Duration::seconds(1);

        let error = sign_prepared_index_at(
            prepared,
            Path::new("/definitely/missing/private.pem"),
            "release-2026",
            after_expiry,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "index has expired");
    }

    #[test]
    fn refuses_to_emit_an_envelope_the_verifier_cannot_read() {
        let payload = vec![b'x'; DOCUMENT_LIMIT as usize - 1];
        let error = signed_envelope(&payload, br#"{"algorithm":"ed25519"}"#).unwrap_err();
        assert_eq!(error.to_string(), "signed index exceeds 32 MiB");
    }
}
