use std::path::{Path, PathBuf};

use sha2::Digest as _;

use crate::binding::{ArtifactSource, ExpectedArtifact, MirrorReceipt, MIRROR_RECEIPT};
use crate::fs::{hash_regular, remove_owned, write_private_synced, Identity};
use crate::github::{Asset, ReleaseClient, UploadAssetRequest, VerifyAssetRequest};
use crate::PublisherError;

pub(crate) fn validated_assets(
    list: Vec<Asset>,
    expected: &[ExpectedArtifact],
    complete: bool,
) -> Result<Vec<Asset>, PublisherError> {
    let mut output = Vec::with_capacity(list.len());
    for item in list {
        let Some(expected) = expected.iter().find(|value| value.name == item.name) else {
            return Err(PublisherError::new("release contains an unexpected asset"));
        };
        if output.iter().any(|value: &Asset| value.name == item.name) {
            return Err(PublisherError::new(format!(
                "duplicate release asset: {}",
                item.name
            )));
        }
        validate_asset_metadata(&item, expected.size, &expected.expected_url)?;
        output.push(item);
    }
    if complete && output.len() != expected.len() {
        return Err(PublisherError::new("release is missing expected assets"));
    }
    Ok(output)
}

pub(crate) fn validated_named_asset(
    list: Vec<Asset>,
    name: &str,
    size: u64,
    expected_url: &str,
) -> Result<Asset, PublisherError> {
    if list.len() != 1 {
        return Err(PublisherError::new(
            "release is missing expected assets or contains unexpected assets",
        ));
    }
    let asset = list.into_iter().next().expect("length checked");
    if asset.name != name {
        return Err(PublisherError::new("release contains an unexpected asset"));
    }
    validate_asset_metadata(&asset, size, expected_url)?;
    Ok(asset)
}

fn validate_asset_metadata(
    asset: &Asset,
    size: u64,
    expected_url: &str,
) -> Result<(), PublisherError> {
    if asset.state != "uploaded" {
        return Err(PublisherError::new("release asset is not uploaded"));
    }
    if asset.size != size || asset.browser_download_url != expected_url {
        return Err(PublisherError::new(
            "release asset metadata does not match publication",
        ));
    }
    Ok(())
}

fn asset<'a>(assets: &'a [Asset], name: &str) -> Option<&'a Asset> {
    assets.iter().find(|asset| asset.name == name)
}

pub(crate) fn verify_present(
    client: &impl ReleaseClient,
    assets: &[Asset],
    expected: &[ExpectedArtifact],
    directory: &Path,
) -> Result<(), PublisherError> {
    for artifact in expected {
        if let Some(remote) = asset(assets, &artifact.name) {
            verify_one(client, remote, artifact, directory)?;
        }
    }
    Ok(())
}

fn verify_one(
    client: &impl ReleaseClient,
    remote: &Asset,
    artifact: &ExpectedArtifact,
    directory: &Path,
) -> Result<(), PublisherError> {
    let temporary = OwnedDirectory::create(directory, ".mirror-verify-")?;
    let output = temporary.path().join("asset");
    let result = client.verify_asset(
        VerifyAssetRequest::builder()
            .asset(remote)
            .expected_url(&artifact.expected_url)
            .sha256(&artifact.sha256)
            .size(artifact.size)
            .output(&output)
            .build(),
    );
    let cleanup = temporary.remove();
    combine_cleanup(result, cleanup)
}

pub(crate) fn upload_one(
    client: &impl ReleaseClient,
    release_id: u64,
    artifact: &ExpectedArtifact,
    expected: &[ExpectedArtifact],
    directory: &Path,
) -> Result<Option<Asset>, PublisherError> {
    let mut owned = None;
    let file = match &artifact.source {
        ArtifactSource::File(path) => path.as_path(),
        ArtifactSource::Bytes(bytes) => {
            let temporary = crate::stage::partial_path(directory, "mirror-upload");
            let identity = write_private_synced(&temporary, bytes)?;
            owned = Some((temporary, identity));
            &owned.as_ref().expect("just assigned").0
        }
    };
    let result = (|| match client.upload_asset(
        UploadAssetRequest::builder()
            .release_id(release_id)
            .name(&artifact.name)
            .file(file)
            .size(artifact.size)
            .build(),
    ) {
        Ok(_) => Ok(None),
        Err(primary) => {
            let assets = validated_assets(client.list_assets(release_id)?, expected, false)?;
            match asset(&assets, &artifact.name) {
                Some(remote) => {
                    verify_one(client, remote, artifact, directory)?;
                    Ok(Some(remote.clone()))
                }
                None => Err(primary),
            }
        }
    })();
    let cleanup = match owned {
        Some((path, identity)) => remove_owned(&path, identity)
            .map_err(|error| PublisherError::io("remove mirror temporary", error)),
        None => Ok(()),
    };
    combine_cleanup(result, cleanup)
}

pub(super) fn validate_local_artifact(artifact: &ExpectedArtifact) -> Result<(), PublisherError> {
    match &artifact.source {
        ArtifactSource::File(path) => {
            let actual = hash_regular(path, artifact.size, "staged mirror artifact")?;
            if actual.size != artifact.size || actual.sha256 != artifact.sha256 {
                return Err(PublisherError::new("staged mirror artifact changed"));
            }
        }
        ArtifactSource::Bytes(bytes)
            if bytes.len() as u64 == artifact.size
                && crate::hex(&sha2::Sha256::digest(bytes)) == artifact.sha256 => {}
        ArtifactSource::Bytes(_) => {
            return Err(PublisherError::new("publication plan bytes changed"))
        }
    }
    Ok(())
}

pub(super) fn publish_receipt(
    directory: &Path,
    receipt: &MirrorReceipt,
) -> Result<(), PublisherError> {
    crate::receipt::publish_canonical_receipt(directory, MIRROR_RECEIPT, receipt)
}

pub(crate) struct OwnedDirectory {
    path: PathBuf,
    identity: Identity,
}

impl OwnedDirectory {
    pub(crate) fn create(parent: &Path, prefix: &str) -> Result<Self, PublisherError> {
        let temporary = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(parent)
            .map_err(|error| PublisherError::io("create mirror temporary", error))?;
        let metadata = std::fs::symlink_metadata(temporary.path())
            .map_err(|error| PublisherError::io("inspect mirror temporary", error))?;
        Ok(Self {
            path: temporary.keep(),
            identity: Identity::from_metadata(&metadata),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn remove(self) -> Result<(), PublisherError> {
        let metadata = std::fs::symlink_metadata(&self.path)
            .map_err(|error| PublisherError::io("inspect mirror temporary", error))?;
        if !self.identity.matches(&metadata) {
            return Err(PublisherError::new(
                "mirror verification directory identity changed",
            ));
        }
        std::fs::remove_dir_all(&self.path)
            .map_err(|error| PublisherError::io("remove mirror temporary", error))
    }
}

pub(crate) fn combine_cleanup<T>(
    primary: Result<T, PublisherError>,
    cleanup: Result<(), PublisherError>,
) -> Result<T, PublisherError> {
    match (primary, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(_)) => Err(PublisherError::cleanup(error, 1)),
    }
}
