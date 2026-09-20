use std::path::Path;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use chrono::{SecondsFormat, Utc};
use ed25519_dalek::pkcs8::{DecodePrivateKey as _, DecodePublicKey as _};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

use crate::error::RegistryError;
use crate::index::validate_index;
use crate::json::{canonical_json_bytes, parse_json};
use crate::package::valid_identifier;
use crate::safe_io::read_bounded_regular;

const DOCUMENT_LIMIT: u64 = 32 * 1024 * 1024;
const KEY_LIMIT: u64 = 16 * 1024;

pub fn sign_index(
    payload_file: &Path,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let signed = read_json(payload_file, DOCUMENT_LIMIT, "payload")?;
    validate_signing_payload(&signed, false)?;
    validate_key_id(key_id)?;
    let pem = Zeroizing::new(read_file(private_key_file, KEY_LIMIT, "private key")?);
    let (label, der) = pem_rfc7468::decode_vec(&pem).map_err(|_| private_key_error())?;
    let der = Zeroizing::new(der);
    if label != "PRIVATE KEY" {
        return Err(private_key_error());
    }
    let key = SigningKey::from_pkcs8_der(&der).map_err(|_| private_key_error())?;
    let payload = canonical_json_bytes(&signed);
    let signature = key.sign(&payload);
    key.verifying_key()
        .verify_strict(&payload, &signature)
        .map_err(|_| RegistryError::single("signature self-verification failed"))?;
    let envelope = json!({
        "signed": signed,
        "signature": {
            "algorithm": "ed25519",
            "key_id": key_id,
            "value": BASE64_STANDARD.encode(signature.to_bytes()),
        }
    });
    Ok(canonical_document(&envelope))
}

pub fn verify_signed_index(
    index_file: &Path,
    public_key_file: &Path,
    key_id: &str,
    allow_expired: bool,
) -> Result<(), RegistryError> {
    validate_key_id(key_id)?;
    let envelope = read_json(index_file, DOCUMENT_LIMIT, "signed index")?;
    let (signed, signature, decoded) = validate_envelope(&envelope, allow_expired)?;
    if signature.get("key_id").and_then(Value::as_str) != Some(key_id) {
        return Err(RegistryError::single(
            "envelope signing key id does not match",
        ));
    }
    let pem = read_file(public_key_file, KEY_LIMIT, "public key")?;
    let (label, der) = pem_rfc7468::decode_vec(&pem).map_err(|_| public_key_error())?;
    if label != "PUBLIC KEY" {
        return Err(public_key_error());
    }
    let key = VerifyingKey::from_public_key_der(&der).map_err(|_| public_key_error())?;
    key.verify_strict(&canonical_json_bytes(signed), &decoded)
        .map_err(|_| RegistryError::single("envelope signature verification failed"))
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

fn validate_signing_payload(value: &Value, allow_expired: bool) -> Result<(), RegistryError> {
    validate_canonical_timestamps(value)?;
    validate_optional_fields(value)?;
    validate_index(value, Utc::now(), allow_expired)
}

fn validate_envelope(
    envelope: &Value,
    allow_expired: bool,
) -> Result<(&Value, &Map<String, Value>, Signature), RegistryError> {
    let object = envelope
        .as_object()
        .ok_or_else(|| RegistryError::single("signed index must be an object"))?;
    reject_unknown(object, &["signed", "signature"], "envelope")?;
    let signed = object
        .get("signed")
        .ok_or_else(|| RegistryError::single("envelope.signed is required"))?;
    validate_signing_payload(signed, allow_expired)?;
    let signature = object.get("signature").and_then(Value::as_object);
    let decoded = validate_signature(signature)?;
    Ok((
        signed,
        signature.expect("validated signature object"),
        decoded,
    ))
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

fn validate_key_id(key_id: &str) -> Result<(), RegistryError> {
    if valid_identifier(key_id) {
        Ok(())
    } else {
        Err(RegistryError::single("signing key id is invalid"))
    }
}

fn validate_canonical_timestamps(signed: &Value) -> Result<(), RegistryError> {
    for field in ["generated_at", "expires_at"] {
        let Some(value) = signed.get(field).and_then(Value::as_str) else {
            continue;
        };
        let parsed = chrono::DateTime::parse_from_rfc3339(value).ok();
        let canonical = parsed.map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        });
        if value.len() != 20 || canonical.as_deref() != Some(value) {
            return Err(RegistryError::single(format!(
                "payload.{field} must use canonical UTC whole-second form YYYY-MM-DDTHH:mm:ssZ"
            )));
        }
    }
    Ok(())
}

fn validate_optional_fields(signed: &Value) -> Result<(), RegistryError> {
    let Some(packages) = signed.get("packages").and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, package) in packages.iter().enumerate() {
        let agent = package.get("agent");
        reject_empty(
            agent,
            "authors",
            &format!("payload.packages[{index}].agent.authors"),
        )?;
        let distribution = agent.and_then(|value| value.get("distribution"));
        if let Some(binary) = distribution
            .and_then(|value| value.get("binary"))
            .and_then(Value::as_object)
        {
            for (target, config) in binary {
                let prefix =
                    format!("payload.packages[{index}].agent.distribution.binary.{target}");
                reject_empty(Some(config), "args", &format!("{prefix}.args"))?;
                reject_empty(Some(config), "env", &format!("{prefix}.env"))?;
            }
        }
        for runner in ["npx", "uvx"] {
            let config = distribution.and_then(|value| value.get(runner));
            let prefix = format!("payload.packages[{index}].agent.distribution.{runner}");
            reject_empty(config, "args", &format!("{prefix}.args"))?;
            reject_empty(config, "env", &format!("{prefix}.env"))?;
        }
    }
    Ok(())
}

fn reject_empty(parent: Option<&Value>, field: &str, label: &str) -> Result<(), RegistryError> {
    let Some(value) = parent.and_then(|value| value.get(field)) else {
        return Ok(());
    };
    if value.as_array().is_some_and(Vec::is_empty) || value.as_object().is_some_and(Map::is_empty) {
        return Err(RegistryError::single(format!(
            "{label} is an empty optional field; omit it before signing"
        )));
    }
    Ok(())
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
