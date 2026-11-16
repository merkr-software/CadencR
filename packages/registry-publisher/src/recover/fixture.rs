use std::path::Path;

use sha2::{Digest as _, Sha256};

use super::*;
use crate::mirror::fixture::{run as mirror, staged, FakeClient};
use crate::{DownloadRequest, Downloaded};

pub(crate) const REPOSITORY: &str = "cadencr/registry";
pub(crate) const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TAG: &str = "provider-acme-v1.0.0";

pub(crate) struct Public<'a>(pub(crate) &'a FakeClient);

impl Downloader for Public<'_> {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        let bytes = self
            .0
            .assets
            .borrow()
            .iter()
            .find(|(asset, _)| asset.browser_download_url == request.url)
            .map(|(_, bytes)| bytes.clone())
            .ok_or_else(|| PublisherError::new("public asset missing"))?;
        std::fs::write(request.output, &bytes)
            .map_err(|error| PublisherError::io("write public fixture", error))?;
        Ok(Downloaded {
            sha256: crate::hex(&Sha256::digest(&bytes)),
            size: bytes.len() as u64,
        })
    }
}

pub(crate) fn published() -> (
    tempfile::TempDir,
    std::path::PathBuf,
    FakeClient,
    MirrorReceipt,
) {
    let (root, submission) = staged();
    let client = FakeClient::default();
    let mirror = mirror(&root, &submission, &client).unwrap();
    client.release.borrow_mut().as_mut().unwrap().draft = false;
    client.tag_commit.replace(Some(COMMIT.to_owned()));
    (root, submission, client, mirror)
}

pub(super) fn run(
    root: &tempfile::TempDir,
    submission: &Path,
    client: &FakeClient,
) -> Result<MirrorReceipt, PublisherError> {
    recover(
        StageRequest::builder()
            .submission(submission)
            .repository(REPOSITORY)
            .directory(root.path())
            .build(),
        COMMIT,
        TAG,
        client,
        &Public(client),
    )
}

pub(super) fn node_oracle(
    root: &tempfile::TempDir,
    submission: &Path,
    client: &FakeClient,
) -> MirrorReceipt {
    let release = client.release.borrow().clone().unwrap();
    let assets = client
        .assets
        .borrow()
        .iter()
        .map(|(asset, bytes)| {
            serde_json::json!({
                "id": asset.id, "name": asset.name, "state": asset.state,
                "browser_download_url": asset.browser_download_url, "size": asset.size,
                "body": crate::hex(bytes),
            })
        })
        .collect::<Vec<_>>();
    let remote = serde_json::json!({
        "release": {"id":release.id,"draft":release.draft,"prerelease":release.prerelease,
            "tag_name":release.tag_name,"target_commitish":release.target_commitish,"body":release.body},
        "assets": assets,
    });
    let submission: serde_json::Value =
        serde_json::from_slice(&std::fs::read(submission).unwrap()).unwrap();
    let input = serde_json::json!({"submission": submission, "remote": remote});
    let captured: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/legacy-v1/recovery-input.json"
    ))
    .unwrap();
    assert_eq!(input, captured, "legacy recovery oracle inputs drifted");
    // Preserve the original oracle's exact receipt bytes and filesystem side effect:
    // the caller verifies Rust recovery produces these bytes, then tests raw replay.
    let bytes = include_bytes!("../../tests/fixtures/legacy-v1/recovery-receipt.json");
    std::fs::write(root.path().join(MIRROR_RECEIPT), bytes).unwrap();
    serde_json::from_slice(bytes).unwrap()
}
