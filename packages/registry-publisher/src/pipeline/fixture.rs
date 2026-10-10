//! In-memory remote transport; real publication/signing/state primitives remain in use.
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;

use super::*;
use crate::github::discovery::{DiscoveryHead, SetDiscoveryRequest};
use crate::github::{Asset, CreateDraftRequest, Release, UploadAssetRequest, VerifyAssetRequest};
use crate::{DownloadRequest, Downloaded};

pub(super) const PRIVATE: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";
pub(super) const PUBLIC: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n";
pub(super) const REPOSITORY: &str = "cadencr/registry";
pub(super) const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Default)]
pub(super) struct Client {
    pub(super) tags: RefCell<HashMap<String, String>>,
    pub(super) releases: RefCell<HashMap<String, Release>>,
    assets: RefCell<HashMap<u64, Vec<Asset>>>,
    bytes: RefCell<HashMap<String, Vec<u8>>>,
    head: RefCell<Option<DiscoveryHead>>,
    pub(super) writes: Cell<u64>,
    pub(super) requests: RefCell<Vec<String>>,
    pub(super) lose_responses: Cell<bool>,
    pub(super) fail_public: Cell<bool>,
    pub(super) dead_sources: Cell<bool>,
}
impl Client {
    fn write(&self) {
        self.writes.set(self.writes.get() + 1);
    }
    fn result<T>(&self, value: T) -> Result<T, PublisherError> {
        if self.lose_responses.get() {
            Err(PublisherError::new("lost fixture response"))
        } else {
            Ok(value)
        }
    }
    fn raw_url(&self) -> String {
        cadencr_registry_core::discovery_url(REPOSITORY, "main").unwrap()
    }
}
impl PipelineClient for Client {
    fn ensure_tag(&self, tag: &str, commit: &str) -> Result<(), PublisherError> {
        let mut tags = self.tags.borrow_mut();
        if let Some(existing) = tags.get(tag) {
            if existing != commit {
                return Err(PublisherError::new("fixture tag conflicts"));
            }
        } else {
            self.write();
            tags.insert(tag.into(), commit.into());
        }
        Ok(())
    }
}
impl ReleaseClient for Client {
    fn get_tag_commit(&self, tag: &str) -> Result<Option<String>, PublisherError> {
        Ok(self.tags.borrow().get(tag).cloned())
    }
    fn find_release(&self, tag: &str) -> Result<Option<Release>, PublisherError> {
        Ok(self.releases.borrow().get(tag).cloned())
    }
    fn create_draft(&self, request: CreateDraftRequest<'_>) -> Result<Release, PublisherError> {
        self.write();
        let release = Release {
            id: self.releases.borrow().len() as u64 + 1,
            draft: true,
            prerelease: false,
            tag_name: request.tag.into(),
            target_commitish: request.commit.into(),
            body: request.body.into(),
        };
        self.releases
            .borrow_mut()
            .insert(request.tag.into(), release.clone());
        self.result(release)
    }
    fn list_assets(&self, id: u64) -> Result<Vec<Asset>, PublisherError> {
        Ok(self.assets.borrow().get(&id).cloned().unwrap_or_default())
    }
    fn upload_asset(&self, request: UploadAssetRequest<'_>) -> Result<Asset, PublisherError> {
        self.write();
        let release = self
            .releases
            .borrow()
            .values()
            .find(|r| r.id == request.release_id)
            .unwrap()
            .clone();
        let bytes = std::fs::read(request.file).unwrap();
        assert_eq!(bytes.len() as u64, request.size);
        let mut assets = self.assets.borrow_mut();
        let list = assets.entry(request.release_id).or_default();
        let asset = Asset {
            id: request.release_id * 100 + list.len() as u64 + 1,
            name: request.name.into(),
            state: "uploaded".into(),
            size: request.size,
            browser_download_url: format!(
                "https://github.com/{REPOSITORY}/releases/download/{}/{}",
                release.tag_name, request.name
            ),
        };
        self.bytes
            .borrow_mut()
            .insert(asset.browser_download_url.clone(), bytes);
        list.push(asset.clone());
        self.result(asset)
    }
    fn verify_asset(&self, request: VerifyAssetRequest<'_>) -> Result<(), PublisherError> {
        let bytes = self.bytes.borrow();
        let bytes = bytes.get(request.expected_url).unwrap();
        assert_eq!(crate::hex(&Sha256::digest(bytes)), request.sha256);
        assert_eq!(bytes.len() as u64, request.size);
        std::fs::write(request.output, bytes).unwrap();
        Ok(())
    }
    fn publish_draft(&self, id: u64) -> Result<Release, PublisherError> {
        self.write();
        let mut releases = self.releases.borrow_mut();
        let release = releases.values_mut().find(|r| r.id == id).unwrap();
        release.draft = false;
        self.result(release.clone())
    }
}
impl DiscoveryClient for Client {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError> {
        assert_eq!(branch, "main");
        Ok(self.head.borrow().clone())
    }
    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError> {
        self.write();
        assert_eq!(
            request.expected_sha,
            self.head.borrow().as_ref().map(|h| h.sha.as_str())
        );
        self.head.replace(Some(DiscoveryHead {
            sha: "c".repeat(40),
            bytes: request.bytes.into(),
        }));
        self.bytes
            .borrow_mut()
            .insert(self.raw_url(), request.bytes.into());
        self.result(())
    }
}
impl Downloader for Client {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        self.requests.borrow_mut().push(request.url.into());
        if request.url.contains("/acme/") && self.dead_sources.get() {
            return Err(PublisherError::new("source retired"));
        }
        if !request.url.contains("/acme/") && self.fail_public.get() {
            return Err(PublisherError::new("public bytes unavailable"));
        }
        let bytes = self.bytes.borrow();
        let bytes = bytes
            .get(request.url)
            .ok_or_else(|| PublisherError::new("unknown fixture download"))?;
        if bytes.len() as u64 > request.max_bytes {
            return Err(PublisherError::new("download exceeds fixture limit"));
        }
        std::fs::write(request.output, bytes).unwrap();
        Ok(Downloaded {
            sha256: crate::hex(&Sha256::digest(bytes)),
            size: bytes.len() as u64,
        })
    }
}

pub(super) struct Fixture {
    pub(super) root: tempfile::TempDir,
    pub(super) request: PathBuf,
    pub(super) state: PathBuf,
    pub(super) private: PathBuf,
    pub(super) client: Client,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = std::fs::canonicalize(root.path()).unwrap();
        let private = base.join("private.pem");
        std::fs::write(&private, PRIVATE).unwrap();
        std::fs::write(base.join("public.pem"), PUBLIC).unwrap();
        let archive = b"archive";
        let source = "https://github.com/acme/provider/releases/download/v1/provider.tgz";
        let submission = json!({"schema_version":1,"package":{
            "agent":{"id":"acme","name":"Acme","version":"1.0.0","description":"Agent","license":"MIT","repository":"https://github.com/acme/provider","distribution":{"binary":{"linux-x86_64":{"archive":source,"cmd":"bin/provider","sha256":crate::hex(&Sha256::digest(archive))}}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.12.0"},"assets":{"icon":"icon.svg","readme":"README.md","license":"LICENSE"}}},
            "source":{"repository":"https://github.com/acme/provider","commit":"a".repeat(40),"tag":"v1"},"changelog":"Release"});
        std::fs::write(
            base.join("submission.json"),
            serde_json::to_vec(&submission).unwrap(),
        )
        .unwrap();
        let output=std::process::Command::new("node").args(["-e","const n=Math.floor(Date.now()/1000)*1000;console.log(new Date(n-60000).toISOString().replace('.000Z','Z'));console.log(new Date(n+86400000).toISOString().replace('.000Z','Z'))"]).output().unwrap();
        let window = String::from_utf8(output.stdout).unwrap();
        let mut times = window.lines();
        let request = base.join("request.json");
        let value = json!({"schema_version":1,"repository":REPOSITORY,"key_id":"release-2026","discovery_branch":"main","generated_at":times.next().unwrap(),"expires_at":times.next().unwrap(),"previous_index":"bootstrap","public_key":"public.pem","publications":[{"submission":"submission.json"}]});
        std::fs::write(&request, serde_json::to_vec(&value).unwrap()).unwrap();
        let client = Client::default();
        client
            .bytes
            .borrow_mut()
            .insert(source.into(), archive.into());
        Self {
            root,
            request,
            state: base.join("state"),
            private,
            client,
        }
    }
    pub(super) fn prepare(&self) -> Result<PreparedPipeline, PublisherError> {
        let digest = crate::hex(&Sha256::digest(std::fs::read(&self.request).unwrap()));
        prepare_registry_publication(
            PipelineRequest::builder()
                .request(&self.request)
                .directory(&self.state)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .private_key(&self.private)
                .confirm_request_sha256(&digest)
                .build(),
        )
    }
    pub(super) fn run(&self) -> Result<PipelineReceipt, PublisherError> {
        run(&self.prepare()?, &self.client, &self.client, &self.client)
    }
    pub(super) fn request_value(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.request).unwrap()).unwrap()
    }
    pub(super) fn write_request(&self, value: Value) {
        std::fs::write(&self.request, serde_json::to_vec(&value).unwrap()).unwrap();
    }
}
