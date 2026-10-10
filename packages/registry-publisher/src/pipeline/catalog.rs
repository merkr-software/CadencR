use super::PreparedPipeline;
use crate::{Downloader, PublisherError};
use std::path::Path;

pub(super) fn snapshot(
    prepared: &PreparedPipeline,
    catalog: &Path,
) -> Result<cadencr_registry_core::CatalogSnapshot, PublisherError> {
    let previous_file = prepared.directory.join("inputs/previous-index.json");
    let previous = if prepared.previous.is_some() {
        cadencr_registry_core::PreviousCatalog::File(&previous_file)
    } else {
        cadencr_registry_core::PreviousCatalog::Bootstrap
    };
    cadencr_registry_core::prepare_catalog_snapshot()
        .catalog_file(catalog)
        .previous(previous)
        .public_key_file(&prepared.directory.join("inputs/public-key.pem"))
        .key_id(&prepared.request.key_id)
        .repository(&prepared.request.repository)
        .registry_commit(&prepared.registry_commit)
        .call()
        .map_err(Into::into)
}

pub(super) fn prepare_candidate(
    prepared: &PreparedPipeline,
    manifest: &Path,
    downloader: &impl Downloader,
) -> Result<cadencr_registry_core::CatalogSnapshot, PublisherError> {
    // Verified release receipts, plans, and independent public artifact bytes
    // are all checked before any signature is created or existing one replayed.
    let payload = crate::catalog::prepare()
        .manifest(manifest)
        .generated_at(&prepared.request.generated_at)
        .expires_at(&prepared.request.expires_at)
        .expected_repository(&prepared.request.repository)
        .downloader(downloader)
        .call()?;
    super::request::revalidate(prepared)?;
    let catalog = prepared.directory.join("managed-index.json");
    if super::state::exists(&catalog)? {
        let snapshot = snapshot(prepared, &catalog)?;
        if snapshot.canonical_payload() != payload.canonical_payload() {
            return Err(PublisherError::new(
                "existing signed catalog conflicts with reconstructed payload",
            ));
        }
        return Ok(snapshot);
    }
    let bytes = cadencr_registry_core::sign_prepared_index_pinned()
        .payload(payload)
        .private_key_file(&prepared.private_key)
        .public_key_bytes(&prepared.public_key)
        .key_id(&prepared.request.key_id)
        .call()?;
    super::state::write_bytes_once(&catalog, &bytes)?;
    snapshot(prepared, &catalog)
}
