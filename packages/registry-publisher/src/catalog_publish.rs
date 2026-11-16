use std::path::Path;

#[cfg(test)]
pub(crate) mod fixture;
pub(crate) mod lifecycle;
mod receipt;

pub(crate) use lifecycle::authoritative_prepare;
use receipt::build_receipt;
pub(crate) use receipt::read_receipt;
pub use receipt::{CatalogPublicationReceipt, PublishCatalogRequest};

use crate::github::{Asset, CreateDraftRequest, Release, ReleaseClient};
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, Downloader, PublisherError};

pub(crate) const ASSET: &str = "managed-index.json";
const LOCK: &str = ".catalog.lock";
const RECEIPT: &str = "catalog-publication-receipt.json";
const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

pub(crate) fn preflight(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
) -> Result<(), PublisherError> {
    crate::publication_local::validate_existing_directory(directory, "catalog publication")?;
    crate::catalog::validate_manifest_repository(manifest, snapshot.repository())?;
    snapshot.revalidate_freshness()?;
    Ok(())
}

pub(crate) fn publish(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    client: &impl ReleaseClient,
) -> Result<CatalogPublicationReceipt, PublisherError> {
    lifecycle::publish_with(
        snapshot,
        manifest,
        directory,
        client,
        &crate::download::ProductionDownloader::default(),
    )
}

pub(crate) fn validate_release(
    release: &Release,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    expected_id: Option<u64>,
    draft: Option<bool>,
) -> Result<(), PublisherError> {
    if !(1..=MAX_SAFE_ID).contains(&release.id) {
        return Err(PublisherError::new("release id is invalid"));
    }
    crate::mirror::release::validate_bound_release(
        release,
        snapshot.tag(),
        snapshot.registry_commit(),
        snapshot.body(),
    )?;
    if expected_id.is_some_and(|id| id != release.id) {
        return Err(PublisherError::new(
            "catalog receipt release id conflicts with GitHub",
        ));
    }
    if draft.is_some_and(|value| value != release.draft) {
        return Err(PublisherError::new(
            "catalog release draft state does not match",
        ));
    }
    Ok(())
}

fn validate_current(
    client: &impl ReleaseClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    id: u64,
    draft: bool,
) -> Result<(), PublisherError> {
    let release = client
        .get_release(id)?
        .ok_or_else(|| PublisherError::new("catalog release is missing"))?;
    validate_release(&release, snapshot, Some(id), Some(draft))
}

fn verify_tag(
    client: &impl ReleaseClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    timing: &str,
) -> Result<(), PublisherError> {
    crate::promote::verify_exact_tag(client, snapshot.tag(), snapshot.registry_commit(), timing)
}

pub(crate) fn expected_artifact(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
) -> Result<crate::binding::ExpectedArtifact, PublisherError> {
    let size = u64::try_from(snapshot.size())
        .map_err(|_| PublisherError::new("catalog size is invalid"))?;
    Ok(crate::binding::ExpectedArtifact {
        name: ASSET.into(),
        sha256: snapshot.sha256().into(),
        size,
        expected_url: snapshot.expected_url().into(),
        source: crate::binding::ArtifactSource::Bytes(snapshot.canonical_envelope().into()),
    })
}

pub(crate) fn catalog_assets(
    list: Vec<Asset>,
    expected: &crate::binding::ExpectedArtifact,
    complete: bool,
) -> Result<Vec<Asset>, PublisherError> {
    crate::mirror::artifacts::validated_assets(list, std::slice::from_ref(expected), complete)
}

#[bon::builder]
fn verify_final(
    client: &impl ReleaseClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    directory: &Path,
    id: u64,
    verified_asset: &Asset,
    expected: &crate::binding::ExpectedArtifact,
    downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<(), PublisherError> {
    validate_current(client, snapshot, id, false)?;
    verify_tag(client, snapshot, "after publication")?;
    let temporary = OwnedDirectory::create(directory, ".catalog-public-")?;
    let result = downloader
        .download(DownloadRequest {
            url: snapshot.expected_url(),
            sha256: snapshot.sha256(),
            output: temporary.path().join(ASSET),
            max_bytes: snapshot.size() as u64,
        })
        .and_then(|value| {
            if value.size == snapshot.size() as u64 && value.sha256 == snapshot.sha256() {
                Ok(())
            } else {
                Err(PublisherError::new(
                    "public catalog size or digest does not match",
                ))
            }
        });
    combine_cleanup(result, temporary.remove())?;
    validate_current(client, snapshot, id, false)?;
    let final_assets = catalog_assets(client.list_assets(id)?, expected, true)?;
    crate::promote::local::require_same_published_assets(
        std::slice::from_ref(verified_asset),
        &final_assets,
    )?;
    verify_tag(client, snapshot, "after public verification")?;
    freshness()?;
    Ok(())
}

fn asset_url_policy(
    release: &Release,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
) -> Result<crate::github::AssetUrlPolicy, PublisherError> {
    if release.draft {
        crate::github::AssetUrlPolicy::bound_draft()
            .release(release)
            .tag(snapshot.tag())
            .commit(snapshot.registry_commit())
            .body(snapshot.body())
            .call()
    } else {
        Ok(crate::github::AssetUrlPolicy::default())
    }
}

#[bon::builder]
fn publish_verified_draft(
    client: &impl ReleaseClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    release_id: u64,
    expected: &crate::binding::ExpectedArtifact,
    verified_asset: &Asset,
    policy: crate::github::AssetUrlPolicy,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<Release, PublisherError> {
    validate_current(client, snapshot, release_id, true)?;
    let current_assets = crate::mirror::artifacts::validated_assets_with_policy(
        client.list_assets(release_id)?,
        std::slice::from_ref(expected),
        true,
        policy,
    )?;
    if current_assets != [verified_asset.clone()] {
        return Err(PublisherError::new(
            "catalog release asset changed before publication",
        ));
    }
    verify_tag(client, snapshot, "before publication PATCH")?;
    freshness()?;
    let release = match client.publish_draft(release_id) {
        Ok(value) => value,
        Err(primary) => match client.get_release(release_id)? {
            Some(value)
                if validate_release(&value, snapshot, Some(release_id), Some(false)).is_ok() =>
            {
                value
            }
            _ => return Err(primary),
        },
    };
    Ok(release)
}
