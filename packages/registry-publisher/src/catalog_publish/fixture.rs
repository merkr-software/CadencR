use std::cell::Cell;
use std::path::PathBuf;

use sha2::{Digest as _, Sha256};
use std::process::Command;

use crate::catalog::fixture::{build, Mode};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

use super::lifecycle::{publish_with, publish_with_freshness};
mod client;

use super::receipt::build_receipt;
use super::{CatalogPublicationReceipt, RECEIPT};
pub(crate) use client::Client;

const PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
const PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";

#[derive(Clone, Copy)]
pub(crate) enum PublicMode {
    Good,
    WrongDigest,
    WrongSize,
    CleanupDrift,
}

pub(crate) struct FlowFixture {
    _catalog: crate::catalog::fixture::Fixture,
    pub(crate) snapshot: cadencr_registry_core::CatalogSnapshot,
    pub(crate) manifest: PathBuf,
    pub(crate) directory: PathBuf,
    pub(crate) client: Client,
    pub(crate) downloader: FlowDownloader,
}

impl FlowFixture {
    pub(crate) fn new() -> Self {
        let mut catalog = build(1, Mode::Good);
        let directory = catalog.directory().join("catalog-publication");
        std::fs::create_dir(&directory).unwrap();
        let output = Command::new("node").args(["-e", "const n=Math.floor(Date.now()/1000)*1000;console.log(new Date(n-60000).toISOString().replace('.000Z','Z'));console.log(new Date(n+86400000).toISOString().replace('.000Z','Z'))"]).output().unwrap();
        let window = String::from_utf8(output.stdout).unwrap();
        let mut window = window.lines();
        let generated = window.next().unwrap().to_owned();
        let expires = window.next().unwrap().to_owned();
        let payload = crate::catalog::prepare()
            .manifest(&catalog.manifest)
            .generated_at(&generated)
            .expires_at(&expires)
            .downloader(&catalog.downloader)
            .call()
            .unwrap();
        let private = catalog.directory().join("private.pem");
        let public = catalog.directory().join("public.pem");
        let candidate = catalog.directory().join("candidate.json");
        std::fs::write(&private, PRIVATE_KEY).unwrap();
        std::fs::write(&public, PUBLIC_KEY).unwrap();
        let envelope =
            cadencr_registry_core::sign_prepared_index(payload, &private, "release-2026").unwrap();
        std::fs::write(&candidate, &envelope).unwrap();
        let snapshot = cadencr_registry_core::prepare_catalog_snapshot()
            .catalog_file(&candidate)
            .previous(cadencr_registry_core::PreviousCatalog::Bootstrap)
            .public_key_file(&public)
            .key_id("release-2026")
            .repository("cadencr/registry")
            .registry_commit(&"b".repeat(40))
            .call()
            .unwrap();
        catalog.downloader.insert(
            snapshot.expected_url().into(),
            snapshot.canonical_envelope().into(),
        );
        let client = Client::new(&snapshot);
        let downloader = FlowDownloader {
            inner: catalog.downloader.values.clone(),
            calls: Cell::new(0),
            public_url: snapshot.expected_url().into(),
            mode: Cell::new(PublicMode::Good),
        };
        Self {
            manifest: catalog.manifest.clone(),
            _catalog: catalog,
            snapshot,
            directory,
            client,
            downloader,
        }
    }
    pub(crate) fn publish(&self) -> Result<CatalogPublicationReceipt, PublisherError> {
        publish_with(
            &self.snapshot,
            &self.manifest,
            &self.directory,
            &self.client,
            &self.downloader,
        )
    }
    pub(super) fn publish_expiring_at(
        &self,
        checkpoint: u64,
    ) -> Result<CatalogPublicationReceipt, PublisherError> {
        let calls = Cell::new(0);
        let freshness = || {
            calls.set(calls.get() + 1);
            if calls.get() == checkpoint {
                Err(PublisherError::new("catalog expired at fixture checkpoint"))
            } else {
                Ok(())
            }
        };
        publish_with_freshness(
            &self.snapshot,
            &self.manifest,
            &self.directory,
            &self.client,
            &self.downloader,
            &freshness,
        )
    }
    pub(super) fn receipt(&self) -> PathBuf {
        self.directory.join(RECEIPT)
    }
    pub(super) fn write_receipt_id(&self, id: u64) {
        let receipt = build_receipt(&self.snapshot, id);
        std::fs::write(self.receipt(), serde_json::to_vec(&receipt).unwrap()).unwrap();
    }
    pub(crate) fn set_manifest_repository(&self, repository: &str) {
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&self.manifest).unwrap()).unwrap();
        value["repository"] = repository.into();
        std::fs::write(&self.manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    pub(super) fn temporary_entries(&self) -> Vec<PathBuf> {
        std::fs::read_dir(&self.directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".catalog-")
                    || p.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".mirror-")
            })
            .collect()
    }
}

pub(crate) struct FlowDownloader {
    inner: std::collections::HashMap<String, Vec<u8>>,
    calls: Cell<u64>,
    public_url: String,
    mode: Cell<PublicMode>,
}
impl FlowDownloader {
    pub(crate) fn insert(&mut self, url: String, bytes: Vec<u8>) {
        self.inner.insert(url, bytes);
    }
    pub(crate) fn set_public_mode(&self, mode: PublicMode) {
        self.mode.set(mode);
    }
    pub(crate) fn calls(&self) -> u64 {
        self.calls.get()
    }
    pub(crate) fn reset_calls(&self) {
        self.calls.set(0);
    }
}
impl Downloader for FlowDownloader {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        self.calls.set(self.calls.get() + 1);
        let bytes = self
            .inner
            .get(request.url)
            .ok_or_else(|| PublisherError::new("unexpected fixture URL"))?;
        std::fs::write(&request.output, bytes).unwrap();
        let mut value = Downloaded {
            sha256: crate::hex(&Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        if request.url == self.public_url {
            match self.mode.get() {
                PublicMode::Good => {}
                PublicMode::WrongDigest => value.sha256 = "0".repeat(64),
                PublicMode::WrongSize => value.size += 1,
                PublicMode::CleanupDrift => {
                    std::fs::remove_file(&request.output).unwrap();
                    let parent = request.output.parent().unwrap();
                    // Keep the original inode alive so Linux cannot reuse it for the replacement.
                    std::fs::rename(parent, parent.with_file_name(".displaced-catalog-fixture"))
                        .unwrap();
                    std::fs::create_dir(parent).unwrap();
                }
            }
        }
        Ok(value)
    }
}
