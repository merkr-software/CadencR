use std::path::Path;
use std::process::Command;

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
    let module = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tooling/marketplace-registry/scripts/publication/recover-publication.mjs");
    let script = r#"
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { recoverPublishedMirror } = await import(pathToFileURL(process.argv[1]));
const remote = JSON.parse(process.argv[5]);
const bytes = (asset) => Buffer.from(asset.body, 'hex');
const client = {
  findRelease: async () => remote.release,
  listAssets: async () => remote.assets.map(({body, ...asset}) => asset),
  verifyAsset: async ({asset, expectedUrl, sha256, size, outputPath}) => {
    const source = remote.assets.find((item) => item.id === asset.id);
    if (asset.browser_download_url !== expectedUrl || source.size !== size) throw new Error('fixture mismatch');
    await writeFile(outputPath, bytes(source));
  },
  getTagCommit: async () => process.argv[4],
};
const download = async ({url, outputPath}) => {
  const source = remote.assets.find((item) => item.browser_download_url === url);
  await writeFile(outputPath, bytes(source));
  return {size: source.size};
};
const submission = JSON.parse(await readFile(process.argv[2], 'utf8'));
const receipt = await recoverPublishedMirror({submission, repository:'cadencr/registry', registryCommit:process.argv[4], directory:process.argv[3], client, download, requirePublished:true});
process.stdout.write(JSON.stringify(receipt));
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(module)
        .arg(submission)
        .arg(root.path())
        .arg(COMMIT)
        .arg(remote.to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
