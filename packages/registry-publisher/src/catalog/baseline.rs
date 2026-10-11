use super::manifest::{resolve_input, Manifest};
use crate::fs::read_bounded;
use crate::PublisherError;
use serde_json::Value;
use std::path::Path;

pub(super) fn prepare(
    manifest: &Manifest,
    base: &Path,
    packages: Vec<Value>,
    generated_at: &str,
    expires_at: &str,
) -> Result<cadencr_registry_core::PreparedSigningPayload, PublisherError> {
    let Some(baseline) = &manifest.baseline else {
        return cadencr_registry_core::prepare_publication_index()
            .packages(packages)
            .schema_version(manifest.schema_version)
            .generated_at(generated_at)
            .expires_at(expires_at)
            .call()
            .map_err(Into::into);
    };
    let previous = read_bounded(
        &resolve_input(base, &baseline.previous_index),
        cadencr_registry_core::MAX_CATALOG_BYTES as u64,
        "previous publication index",
    )?;
    let public_key = read_bounded(
        &resolve_input(base, &baseline.public_key),
        16 * 1024,
        "publication baseline public key",
    )?;
    cadencr_registry_core::prepare_incremental_publication_index()
        .previous_bytes(&previous)
        .public_key_bytes(&public_key)
        .key_id(&baseline.key_id)
        .schema_version(manifest.schema_version)
        .allow_schema_upgrade(manifest.allow_schema_upgrade)
        .packages(packages)
        .generated_at(generated_at)
        .expires_at(expires_at)
        .call()
        .map_err(Into::into)
}
