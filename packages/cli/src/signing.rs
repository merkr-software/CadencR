use std::path::Path;

use crate::{operation_error, output, Diagnostic};

pub(crate) fn sign(
    payload: &Path,
    private_key: &Path,
    key_id: &str,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let bytes = cadencr_registry_core::sign_index(payload, private_key, key_id)
        .map_err(|error| operation_error("REGISTRY_SIGNING_FAILED", error))?;
    output::write_bytes(&bytes, Some(destination))?;
    Ok(Some(format!(
        "wrote signed index: {}",
        destination.display()
    )))
}

pub(crate) fn verify(
    index: &Path,
    public_key: &Path,
    key_id: &str,
    allow_expired: bool,
) -> Result<Option<String>, Diagnostic> {
    cadencr_registry_core::verify_signed_index(index, public_key, key_id, allow_expired)
        .map_err(|error| operation_error("REGISTRY_VERIFICATION_FAILED", error))?;
    Ok(Some(format!("verified signed index: {}", index.display())))
}

pub(crate) fn assemble(
    payload: &Path,
    signature: &Path,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let bytes = cadencr_registry_core::assemble_signed_index(payload, signature)
        .map_err(|error| operation_error("REGISTRY_ASSEMBLY_FAILED", error))?;
    output::write_bytes(&bytes, Some(destination))?;
    Ok(Some(format!(
        "assembled signed index: {}",
        destination.display()
    )))
}
