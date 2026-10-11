use std::cell::Cell;

use sha2::{Digest as _, Sha256};

use super::lifecycle::advance_with;
use super::DiscoveryReceipt;
use crate::catalog_publish::fixture::Client;
use crate::catalog_publish::fixture::FlowFixture;
use crate::{DownloadRequest, Downloader, PublisherError};

#[derive(Clone, Copy)]
pub(super) enum RawMode {
    Good,
    WrongDigest,
    WrongSize,
}
pub(super) struct Raw {
    bytes: Vec<u8>,
    url: String,
    sha256: String,
    mode: Cell<RawMode>,
    calls: Cell<u64>,
}
impl Raw {
    pub(super) fn set_mode(&self, mode: RawMode) {
        self.mode.set(mode);
    }
    pub(super) fn calls(&self) -> u64 {
        self.calls.get()
    }
}
impl Downloader for Raw {
    fn download(&self, request: DownloadRequest<'_>) -> Result<crate::Downloaded, PublisherError> {
        self.calls.set(self.calls.get() + 1);
        assert_eq!(request.url, self.url);
        std::fs::write(&request.output, &self.bytes).unwrap();
        let mut value = crate::Downloaded {
            sha256: crate::hex(&Sha256::digest(&self.bytes)),
            size: self.bytes.len() as u64,
        };
        assert_eq!(value.sha256, self.sha256);
        match self.mode.get() {
            RawMode::Good => {}
            RawMode::WrongDigest => value.sha256 = "0".repeat(64),
            RawMode::WrongSize => value.size += 1,
        }
        Ok(value)
    }
}
pub(super) fn setup() -> (FlowFixture, Raw) {
    let value = FlowFixture::new();
    value.publish().unwrap();
    value.client.reset_api_observations();
    value.downloader.reset_calls();
    let raw = Raw {
        bytes: value.snapshot.canonical_envelope().into(),
        url: cadencr_registry_core::discovery_url(value.snapshot.repository(), "main").unwrap(),
        sha256: value.snapshot.sha256().into(),
        mode: Cell::new(RawMode::Good),
        calls: Cell::new(0),
    };
    (value, raw)
}

pub(super) fn setup_baseline() -> (FlowFixture, Raw) {
    const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
    const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";
    let mut value = FlowFixture::new();
    let previous = value.directory.join("previous.json");
    std::fs::write(&previous, value.snapshot.canonical_envelope()).unwrap();
    let private = value.directory.join("next-private.pem");
    let public = value.directory.join("next-public.pem");
    let candidate = value.directory.join("next-candidate.json");
    std::fs::write(&private, PRIVATE).unwrap();
    std::fs::write(&public, PUBLIC).unwrap();
    let output = std::process::Command::new("node").args(["-e", "const n=Math.floor(Date.now()/1000)*1000;console.log(new Date(n).toISOString().replace('.000Z','Z'));console.log(new Date(n+86400000).toISOString().replace('.000Z','Z'))"]).output().unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    let mut window = text.lines();
    let payload = crate::catalog::prepare()
        .manifest(&value.manifest)
        .generated_at(window.next().unwrap())
        .expires_at(window.next().unwrap())
        .downloader(&value.downloader)
        .call()
        .unwrap();
    let envelope =
        cadencr_registry_core::sign_prepared_index(payload, &private, "release-2026").unwrap();
    std::fs::write(&candidate, &envelope).unwrap();
    let snapshot = cadencr_registry_core::prepare_catalog_snapshot()
        .catalog_file(&candidate)
        .previous(cadencr_registry_core::PreviousCatalog::File(&previous))
        .public_key_file(&public)
        .key_id("release-2026")
        .repository("cadencr/registry")
        .registry_commit(&"b".repeat(40))
        .call()
        .unwrap();
    value.downloader.insert(
        snapshot.expected_url().into(),
        snapshot.canonical_envelope().into(),
    );
    value.client = Client::new(&snapshot);
    value.snapshot = snapshot;
    value.publish().unwrap();
    value.client.reset_api_observations();
    value.downloader.reset_calls();
    let raw = Raw {
        bytes: value.snapshot.canonical_envelope().into(),
        url: cadencr_registry_core::discovery_url(value.snapshot.repository(), "main").unwrap(),
        sha256: value.snapshot.sha256().into(),
        mode: Cell::new(RawMode::Good),
        calls: Cell::new(0),
    };
    (value, raw)
}
pub(super) fn run(value: &FlowFixture, raw: &Raw) -> Result<DiscoveryReceipt, PublisherError> {
    advance_with(
        &value.snapshot,
        &value.manifest,
        &value.directory,
        "main",
        &value.client,
        &value.downloader,
        raw,
    )
}

pub(super) fn assert_js_receipt(
    receipt: &DiscoveryReceipt,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
) {
    let script = r#"let [repository,branch,url,snapshotSha,baseline,blob,releaseId,tag,commit]=process.argv.slice(1);process.stdout.write(JSON.stringify({schema_version:1,status:'discovery_verified',repository,branch,url,snapshot_sha256:snapshotSha,baseline_sha256:baseline,blob_sha:blob,release_id:Number(releaseId),release_tag:tag,registry_commit:commit,tag_commit:commit}))"#;
    let output = std::process::Command::new("node")
        .args([
            "-e",
            script,
            snapshot.repository(),
            &receipt.branch,
            &receipt.url,
            snapshot.sha256(),
            snapshot.previous_sha256().unwrap_or("bootstrap"),
            &receipt.blob_sha,
            &receipt.release_id.to_string(),
            snapshot.tag(),
            snapshot.registry_commit(),
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let oracle: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(serde_json::to_value(receipt).unwrap(), oracle);
}
