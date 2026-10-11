use super::*;

pub fn sign_theme_blocklist(
    payload_file: &Path,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let value = read_json(
        payload_file,
        crate::MAX_THEME_BLOCKLIST_BYTES as u64,
        "theme blocklist",
    )?;
    let prepared = crate::prepare_theme_blocklist(&value, false, Utc::now())?;
    sign_prepared_index(prepared.signing, private_key_file, key_id)
}

pub fn verify_signed_theme_blocklist(
    index_file: &Path,
    public_key_file: &Path,
    key_id: &str,
    allow_expired: bool,
) -> Result<(), RegistryError> {
    validate_signing_key_id(key_id)?;
    let envelope = read_json(
        index_file,
        crate::MAX_SIGNED_THEME_BLOCKLIST_BYTES as u64,
        "signed theme blocklist",
    )?;
    let object = envelope
        .as_object()
        .ok_or_else(|| RegistryError::single("theme blocklist envelope must be an object"))?;
    reject_unknown(object, &["signed", "signature"], "envelope")?;
    let signed = object
        .get("signed")
        .ok_or_else(|| RegistryError::single("envelope.signed is required"))?;
    let signature = object.get("signature").and_then(Value::as_object);
    let decoded = validate_signature(signature)?;
    let payload = canonical_json_bytes(signed);
    let validated = ValidatedEnvelope {
        signature: signature.expect("validated signature"),
        decoded,
        payload,
    };
    validate_envelope_key_id(&validated, key_id)?;
    let key = parse_public_key(&read_file(public_key_file, KEY_LIMIT, "public key")?)?;
    verify_validated_signature(validated, &key)?;
    crate::prepare_theme_blocklist(signed, allow_expired, Utc::now()).map(|_| ())
}
