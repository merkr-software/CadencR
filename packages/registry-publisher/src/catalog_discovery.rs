#[cfg(test)]
mod fixture;
mod receipt;
mod validation;
mod verification;

use std::path::Path;

pub use receipt::DiscoveryReceipt;

use crate::catalog_publish::read_receipt as read_catalog_receipt;
use crate::github::discovery::DiscoveryClient;
use crate::github::ReleaseClient;
use crate::PublisherError;

const LOCK: &str = ".catalog.lock";

fn reject_symbolic_lock(directory: &Path) -> Result<(), PublisherError> {
    match std::fs::symlink_metadata(directory.join(LOCK)) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(PublisherError::new(
            "catalog lock must not be a symbolic link",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(PublisherError::io("inspect catalog lock", error)),
    }
}

#[derive(bon::Builder)]
pub struct AdvanceCatalogRequest<'a> {
    pub snapshot: &'a cadencr_registry_core::CatalogSnapshot,
    pub manifest: &'a Path,
    pub directory: &'a Path,
    pub discovery_branch: &'a str,
    pub token: &'a str,
}

pub(crate) fn preflight(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
) -> Result<(), PublisherError> {
    cadencr_registry_core::validate_discovery_branch(branch)?;
    crate::publication_local::validate_existing_directory(directory, "catalog publication")?;
    reject_symbolic_lock(directory)?;
    crate::catalog::validate_manifest_repository(manifest, snapshot.repository())?;
    let catalog = read_catalog_receipt(directory, snapshot)?
        .ok_or_else(|| PublisherError::new("catalog publication receipt is required"))?;
    let prior = receipt::read(directory)?;
    receipt::validate_binding(prior.as_ref(), snapshot, branch, catalog.release_id)?;
    snapshot.revalidate_freshness()?;
    Ok(())
}

pub(crate) fn advance(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    branch: &str,
    client: &(impl DiscoveryClient + ReleaseClient),
) -> Result<DiscoveryReceipt, PublisherError> {
    let downloader = crate::download::ProductionDownloader::default();
    let raw = crate::download::DiscoveryDownloader::default();
    lifecycle::advance_preflighted(
        snapshot,
        manifest,
        directory,
        branch,
        client,
        &downloader,
        &raw,
    )
}

mod lifecycle;
