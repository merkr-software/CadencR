use super::{private_key_error, read_file, DOCUMENT_LIMIT, KEY_LIMIT};
use crate::{canonical_json_bytes, RegistryError};
use base64::prelude::{Engine as _, BASE64_STANDARD};
use ed25519_dalek::pkcs8::DecodePrivateKey as _;
use ed25519_dalek::{Signer as _, SigningKey, VerifyingKey};
use serde_json::json;
use std::path::Path;
use zeroize::Zeroizing;

pub(crate) fn sign_canonical_payload(
    payload: &[u8],
    private_key_file: &Path,
    key_id: &str,
    pinned_key: Option<&VerifyingKey>,
) -> Result<Vec<u8>, RegistryError> {
    let key = read_signing_key(private_key_file)?;
    if pinned_key.is_some_and(|pinned| key.verifying_key() != *pinned) {
        return Err(RegistryError::single(
            "private key does not match pinned public key",
        ));
    }
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

pub(super) fn signed_envelope(payload: &[u8], signature: &[u8]) -> Result<Vec<u8>, RegistryError> {
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

pub(crate) fn read_signing_key(private_key_file: &Path) -> Result<SigningKey, RegistryError> {
    let pem = Zeroizing::new(read_file(private_key_file, KEY_LIMIT, "private key")?);
    let (label, der) = pem_rfc7468::decode_vec(&pem).map_err(|_| private_key_error())?;
    let der = Zeroizing::new(der);
    if label != "PRIVATE KEY" {
        return Err(private_key_error());
    }
    SigningKey::from_pkcs8_der(&der).map_err(|_| private_key_error())
}
