use std::path::Path;

use cadencr_registry_core::{RegistryTrustFiles, VerifiedRegistryTrust};

use crate::{args::TrustArgs, operation_error, output, Diagnostic};

pub(crate) fn load(
    args: &TrustArgs,
    code: &'static str,
) -> Result<Option<VerifiedRegistryTrust>, Diagnostic> {
    let Some(manifest) = &args.trust_manifest else {
        return Ok(None);
    };
    let files = RegistryTrustFiles {
        manifest: manifest.clone(),
        root_public_key: args
            .trust_root_public_key
            .clone()
            .expect("clap requires root key"),
        root_key_id: args
            .trust_root_key_id
            .clone()
            .expect("clap requires root identity"),
        minimum_generation: args.trust_minimum_generation.unwrap_or(1),
    };
    files
        .load()
        .map(Some)
        .map_err(|error| operation_error(code, error))
}

pub(crate) fn sign(
    payload: &Path,
    private_key: &Path,
    key_id: &str,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let bytes = cadencr_registry_core::sign_registry_trust_manifest(payload, private_key, key_id)
        .map_err(|error| operation_error("REGISTRY_TRUST_SIGN_FAILED", error))?;
    output::write_bytes(&bytes, Some(destination))?;
    Ok(Some(format!(
        "wrote signed trust manifest: {}",
        destination.display()
    )))
}

pub(crate) fn verify(
    manifest: &Path,
    public_key: &Path,
    key_id: &str,
    minimum_generation: u64,
) -> Result<Option<String>, Diagnostic> {
    let files = RegistryTrustFiles {
        manifest: manifest.into(),
        root_public_key: public_key.into(),
        root_key_id: key_id.into(),
        minimum_generation,
    };
    let trust = files
        .load()
        .map_err(|error| operation_error("REGISTRY_TRUST_VERIFY_FAILED", error))?;
    Ok(Some(format!(
        "valid registry trust generation {}",
        trust.generation()
    )))
}
