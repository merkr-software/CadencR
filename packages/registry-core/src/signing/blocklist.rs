use super::*;
use crate::blocklist::MAX_BLOCKLIST_BYTES;
use crate::{authenticate_policy, PolicyKind};

/// Sign `kind`'s revocation policy, which must be current, with the catalog
/// key.
pub fn sign_policy(
    kind: PolicyKind,
    payload_file: &Path,
    private_key_file: &Path,
    key_id: &str,
) -> Result<Vec<u8>, RegistryError> {
    let label = format!("{} blocklist", kind.name());
    let value = read_json(payload_file, MAX_BLOCKLIST_BYTES as u64, &label)?;
    let prepared = kind.prepare(&value, false, Utc::now())?;
    sign_prepared_index(prepared, private_key_file, key_id)
}

/// Authenticate a signed `kind` policy file and validate its domain.
pub fn verify_policy(
    kind: PolicyKind,
    index_file: &Path,
    public_key_file: &Path,
    key_id: &str,
    allow_expired: bool,
) -> Result<(), RegistryError> {
    let label = format!("signed {} blocklist", kind.name());
    validate_signing_key_id(key_id)?;
    let bytes = read_file(index_file, kind.max_signed_bytes() as u64, &label)?;
    let public_key = read_file(public_key_file, KEY_LIMIT, "public key")?;
    authenticate_policy(kind, &bytes, &public_key, key_id, allow_expired, Utc::now()).map(|_| ())
}
