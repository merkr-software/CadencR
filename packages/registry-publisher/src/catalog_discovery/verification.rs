use std::path::Path;

use crate::github::discovery::DiscoveryClient;
use crate::github::ReleaseClient;
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, Downloader, PublisherError};

pub(super) fn validate_remote_catalog(
    client: &(impl DiscoveryClient + ReleaseClient),
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    release_id: u64,
) -> Result<(), PublisherError> {
    let release = client
        .find_release(snapshot.tag())?
        .ok_or_else(|| PublisherError::new("catalog release is missing"))?;
    crate::catalog_publish::validate_release(&release, snapshot, Some(release_id), Some(false))?;
    crate::promote::verify_exact_tag(
        client,
        snapshot.tag(),
        snapshot.registry_commit(),
        "before discovery advancement",
    )?;
    crate::mirror::artifacts::validated_named_asset(
        client.list_assets(release_id)?,
        crate::catalog_publish::ASSET,
        snapshot.size() as u64,
        snapshot.expected_url(),
    )?;
    Ok(())
}

pub(super) fn verify_public_catalog(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_download(
        snapshot.expected_url(),
        snapshot.sha256(),
        snapshot.size() as u64,
        directory,
        ".discovery-catalog-",
        downloader,
        "public catalog",
    )
}

pub(super) fn verify_raw(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    branch: &str,
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    let url = cadencr_registry_core::discovery_url(snapshot.repository(), branch)?;
    verify_download(
        &url,
        snapshot.sha256(),
        snapshot.size() as u64,
        directory,
        ".discovery-public-",
        downloader,
        "public discovery",
    )
}

fn verify_download(
    url: &str,
    sha256: &str,
    size: u64,
    directory: &Path,
    prefix: &str,
    downloader: &impl Downloader,
    label: &str,
) -> Result<(), PublisherError> {
    let temporary = OwnedDirectory::create(directory, prefix)?;
    let result = downloader
        .download(DownloadRequest {
            url,
            sha256,
            output: temporary
                .path()
                .join(cadencr_registry_core::DISCOVERY_FILENAME),
            max_bytes: size,
        })
        .and_then(|actual| {
            if actual.size == size && actual.sha256 == sha256 {
                Ok(())
            } else {
                Err(PublisherError::new(format!(
                    "{label} size or digest does not match"
                )))
            }
        });
    combine_cleanup(result, temporary.remove())
}
