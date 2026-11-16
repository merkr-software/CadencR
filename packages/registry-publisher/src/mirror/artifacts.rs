use std::path::{Path, PathBuf};

use sha2::Digest as _;

use crate::binding::{ArtifactSource, ExpectedArtifact, MirrorReceipt, MIRROR_RECEIPT};
use crate::convergence::{converge, Converged, ReadBack, Verdict};
use crate::fs::{hash_regular, remove_owned, write_private_synced, Identity};
use crate::github::AssetUrlPolicy;
use crate::github::{Asset, ReleaseClient, UploadAssetRequest, VerifyAssetRequest};
use crate::PublisherError;

pub(crate) struct AssetMetadata<'a> {
    pub(crate) name: &'a str,
    pub(crate) size: Option<u64>,
    pub(crate) expected_url: &'a str,
}

pub(crate) fn validated_assets_with_policy(
    list: Vec<Asset>,
    expected: &[ExpectedArtifact],
    complete: bool,
    policy: AssetUrlPolicy,
) -> Result<Vec<Asset>, PublisherError> {
    let metadata = expected
        .iter()
        .map(|artifact| AssetMetadata {
            name: &artifact.name,
            size: Some(artifact.size),
            expected_url: &artifact.expected_url,
        })
        .collect::<Vec<_>>();
    validated_metadata_with_policy(list, &metadata, complete, policy)
}

/// A missing expected size defers only byte length; all other asset identity
/// checks remain identical for pre-acquisition and fully bound verification.
pub(crate) fn validated_metadata_with_policy(
    list: Vec<Asset>,
    expected: &[AssetMetadata<'_>],
    complete: bool,
    policy: AssetUrlPolicy,
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
        validate_asset_metadata(&item, expected, policy)?;
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
    let mut assets = validated_metadata(
        list,
        &[AssetMetadata {
            name,
            size: Some(size),
            expected_url,
        }],
        true,
    )?;
    Ok(assets.pop().expect("complete single-asset set"))
}

fn validate_asset_metadata(
    asset: &Asset,
    expected: &AssetMetadata<'_>,
    policy: AssetUrlPolicy,
) -> Result<(), PublisherError> {
    if asset.state != "uploaded" {
        return Err(PublisherError::new("release asset is not uploaded"));
    }
    if expected.size.is_some_and(|size| asset.size != size)
        || !policy.matches(&asset.browser_download_url, expected.expected_url)
    {
        return Err(PublisherError::new(
            "release asset metadata does not match publication",
        ));
    }
    Ok(())
}

fn asset<'a>(assets: &'a [Asset], name: &str) -> Option<&'a Asset> {
    assets.iter().find(|asset| asset.name == name)
}

pub(crate) fn verify_present_with_policy(
    client: &impl ReleaseClient,
    assets: &[Asset],
    expected: &[ExpectedArtifact],
    directory: &Path,
    policy: AssetUrlPolicy,
) -> Result<(), PublisherError> {
    for artifact in expected {
        if let Some(remote) = asset(assets, &artifact.name) {
            verify_one(client, remote, artifact, directory, policy)?;
        }
    }
    Ok(())
}

fn verify_one(
    client: &impl ReleaseClient,
    remote: &Asset,
    artifact: &ExpectedArtifact,
    directory: &Path,
    policy: AssetUrlPolicy,
) -> Result<(), PublisherError> {
    let temporary = OwnedDirectory::create(directory, ".mirror-verify-")?;
    let output = temporary.path().join("asset");
    let result = client.verify_asset(
        VerifyAssetRequest::builder()
            .url_policy(policy)
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

/// Upload one artifact. After an accepted upload the listing is awaited within
/// `pacing` until the asset shows (a listing without it is the stale
/// pre-upload set); a listed asset that does not match, or any unexpected
/// asset, is refused at once. A failed or lost upload is reconciled by one
/// listing: a verified asset is returned as `recovered`, otherwise the
/// upload's own error. Either way the validated listing that settled it is
/// returned, so the caller need not list again.
#[bon::builder]
pub(crate) fn upload_one(
    client: &impl ReleaseClient,
    release_id: u64,
    artifact: &ExpectedArtifact,
    expected: &[ExpectedArtifact],
    directory: &Path,
    policy: AssetUrlPolicy,
    pacing: &ReadBack,
) -> Result<Uploaded, PublisherError> {
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
        Ok(_) => {
            await_listed(client, release_id, artifact, expected, policy, pacing).map(|assets| {
                Uploaded {
                    assets,
                    recovered: None,
                }
            })
        }
        Err(primary) => {
            let assets = validated_assets_with_policy(
                client.list_assets(release_id)?,
                expected,
                false,
                policy,
            )?;
            match asset(&assets, &artifact.name) {
                Some(remote) => {
                    verify_one(client, remote, artifact, directory, policy)?;
                    let recovered = Some(remote.clone());
                    Ok(Uploaded { assets, recovered })
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

/// The settled state after an upload.
pub(crate) struct Uploaded {
    /// The validated release listing, the artifact among its assets.
    pub(crate) assets: Vec<Asset>,
    /// The artifact as found by reconciling a failed or lost upload response.
    pub(crate) recovered: Option<Asset>,
}

fn await_listed(
    client: &impl ReleaseClient,
    release_id: u64,
    artifact: &ExpectedArtifact,
    expected: &[ExpectedArtifact],
    policy: AssetUrlPolicy,
    pacing: &ReadBack,
) -> Result<Vec<Asset>, PublisherError> {
    let converged = converge(
        pacing,
        |deadline| client.list_assets_before(release_id, deadline),
        |list| {
            // A mismatching or unexpected asset is terminal, not lag.
            let assets = validated_assets_with_policy(list, expected, false, policy)?;
            Ok(if asset(&assets, &artifact.name).is_some() {
                Verdict::Done(assets)
            } else {
                Verdict::Stale
            })
        },
    )?;
    match converged {
        Converged::Done(assets) => Ok(assets),
        Converged::Foreign => Err(PublisherError::new(
            "release asset listing changed unexpectedly after upload",
        )),
        Converged::Stale(reads) => Err(PublisherError::new(format!(
            "release asset {} was uploaded but {reads} listings over {}s still returned the \
             stale pre-upload set; re-run to verify once the asset is listed",
            artifact.name,
            pacing.budget.as_secs()
        ))),
    }
}

pub(crate) fn validate_local_artifact(artifact: &ExpectedArtifact) -> Result<(), PublisherError> {
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

pub(crate) fn validated_assets(
    list: Vec<Asset>,
    expected: &[ExpectedArtifact],
    complete: bool,
) -> Result<Vec<Asset>, PublisherError> {
    validated_assets_with_policy(list, expected, complete, AssetUrlPolicy::default())
}

pub(crate) fn validated_metadata(
    list: Vec<Asset>,
    expected: &[AssetMetadata<'_>],
    complete: bool,
) -> Result<Vec<Asset>, PublisherError> {
    validated_metadata_with_policy(list, expected, complete, AssetUrlPolicy::default())
}

pub(crate) fn verify_present(
    client: &impl ReleaseClient,
    assets: &[Asset],
    expected: &[ExpectedArtifact],
    directory: &Path,
) -> Result<(), PublisherError> {
    verify_present_with_policy(
        client,
        assets,
        expected,
        directory,
        AssetUrlPolicy::default(),
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::convergence::VirtualClock;
    use crate::mirror::fixture::FakeClient;

    const BYTES: &[u8] = b"archive";
    const URL: &str =
        "https://github.com/cadencr/registry/releases/download/provider-acme-v1.0.0/a.tgz";

    fn artifact() -> ExpectedArtifact {
        ExpectedArtifact {
            name: "a.tgz".into(),
            sha256: crate::hex(&sha2::Sha256::digest(BYTES)),
            size: BYTES.len() as u64,
            source: ArtifactSource::Bytes(BYTES.to_vec()),
            expected_url: URL.into(),
        }
    }

    fn upload(client: &FakeClient, clock: &VirtualClock) -> Result<Uploaded, PublisherError> {
        let artifact = artifact();
        let directory = tempfile::tempdir().unwrap();
        upload_one()
            .client(client)
            .release_id(7)
            .artifact(&artifact)
            .expected(std::slice::from_ref(&artifact))
            .directory(directory.path())
            .policy(AssetUrlPolicy::default())
            .pacing(&clock.read_back())
            .call()
    }

    fn lagging(reads: u64) -> FakeClient {
        let client = FakeClient::default();
        client.upload_lag.set(reads);
        client
    }

    #[test]
    fn an_upload_waits_out_listings_that_still_show_the_pre_upload_set() {
        let client = lagging(3);
        let clock = VirtualClock::new();
        let uploaded = upload(&client, &clock).unwrap();
        assert!(uploaded.recovered.is_none());
        assert_eq!(uploaded.assets.len(), 1, "the settled listing is returned");
        assert_eq!(client.uploads.get(), 1, "the upload is never repeated");
        assert_eq!(client.asset_lists.get(), 4);
        let backoff: Vec<_> = [250, 500, 1000].map(Duration::from_millis).into();
        assert_eq!(*clock.waits.borrow(), backoff);
    }

    #[test]
    fn listings_stale_for_the_whole_budget_fail_with_a_stale_message() {
        let client = lagging(u64::MAX);
        let clock = VirtualClock::new();
        let message = upload(&client, &clock).err().unwrap().to_string();
        assert!(message.contains("stale pre-upload set"), "{message}");
        assert_eq!(client.uploads.get(), 1);
        let waited: Duration = clock.waits.borrow().iter().sum();
        assert!(waited <= Duration::from_secs(30), "{waited:?}");
        assert!(waited > Duration::from_secs(15), "{waited:?}");
    }

    #[test]
    fn a_listed_asset_that_does_not_match_stops_at_once() {
        let client = FakeClient {
            skew_listed_size: true,
            ..Default::default()
        };
        let clock = VirtualClock::new();
        let message = upload(&client, &clock).err().unwrap().to_string();
        assert!(message.contains("metadata does not match"), "{message}");
        assert!(clock.waits.borrow().is_empty());
        assert_eq!(client.asset_lists.get(), 1);
    }

    #[test]
    fn an_unexpected_asset_in_the_listing_stops_at_once() {
        let client = FakeClient::default();
        client.assets.borrow_mut().push((
            Asset {
                id: 99,
                name: "foreign".into(),
                state: "uploaded".into(),
                browser_download_url: "x".into(),
                size: 1,
            },
            vec![0],
        ));
        let clock = VirtualClock::new();
        let message = upload(&client, &clock).err().unwrap().to_string();
        assert!(message.contains("unexpected asset"), "{message}");
        assert!(clock.waits.borrow().is_empty());
    }

    #[test]
    fn a_lost_upload_response_is_reconciled_by_one_listing_without_waiting() {
        let client = FakeClient {
            lose_upload: true,
            ..Default::default()
        };
        let clock = VirtualClock::new();
        let uploaded = upload(&client, &clock).unwrap();
        assert_eq!(uploaded.recovered.expect("asset recovered").name, "a.tgz");
        assert_eq!(uploaded.assets.len(), 1);
        assert!(clock.waits.borrow().is_empty());
        // A lost response whose asset is not yet listed keeps its own error.
        let client = FakeClient {
            lose_upload: true,
            ..Default::default()
        };
        client.upload_lag.set(5);
        let message = upload(&client, &clock).err().unwrap().to_string();
        assert_eq!(message, "lost upload response");
        assert!(clock.waits.borrow().is_empty());
    }
}
