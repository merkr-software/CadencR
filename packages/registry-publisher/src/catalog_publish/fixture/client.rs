use crate::github::{
    Asset, CreateDraftRequest, Release, ReleaseClient, UploadAssetRequest, VerifyAssetRequest,
};
use crate::PublisherError;
use std::cell::RefCell;

#[derive(Default)]
struct State {
    release: Option<Release>,
    assets: Vec<Asset>,
    create: u64,
    upload: u64,
    patch: u64,
    verifies: u64,
    api: u64,
    tag_calls: u64,
    list_calls: u64,
    lost: bool,
    fail_patch: bool,
    wrong_patch_id: bool,
    fail_tag: Option<u64>,
    drift_asset: Option<u64>,
    fail_list: Option<u64>,
    asset_fault: Option<&'static str>,
    fail_verify: bool,
}

pub(crate) struct Client {
    state: RefCell<State>,
    tag: String,
    commit: String,
    body: String,
    url: String,
    bytes: Vec<u8>,
    sha256: String,
}
impl Client {
    pub(crate) fn new(snapshot: &cadencr_registry_core::CatalogSnapshot) -> Self {
        Self {
            state: RefCell::new(State::default()),
            tag: snapshot.tag().into(),
            commit: snapshot.registry_commit().into(),
            body: snapshot.body().into(),
            url: snapshot.expected_url().into(),
            bytes: snapshot.canonical_envelope().into(),
            sha256: snapshot.sha256().into(),
        }
    }
    pub(crate) fn set_lost_responses(&self, value: bool) {
        self.state.borrow_mut().lost = value;
    }
    pub(crate) fn mutations(&self) -> (u64, u64, u64) {
        let s = self.state.borrow();
        (s.create, s.upload, s.patch)
    }
    pub(crate) fn api_calls(&self) -> u64 {
        self.state.borrow().api
    }
    pub(crate) fn verifies(&self) -> u64 {
        self.state.borrow().verifies
    }
    pub(crate) fn fail_patch(&self) {
        self.state.borrow_mut().fail_patch = true;
    }
    pub(crate) fn wrong_patch_id(&self) {
        self.state.borrow_mut().wrong_patch_id = true;
    }
    pub(crate) fn fail_tag_at(&self, n: u64) {
        self.state.borrow_mut().fail_tag = Some(n);
    }
    pub(crate) fn drift_asset_id_at(&self, n: u64) {
        self.state.borrow_mut().drift_asset = Some(n);
    }
    pub(crate) fn fail_list_at(&self, n: u64) {
        self.state.borrow_mut().fail_list = Some(n);
    }
    pub(crate) fn is_draft(&self) -> bool {
        self.state.borrow().release.as_ref().unwrap().draft
    }
    pub(crate) fn start_published_without_asset(&self) {
        self.state.borrow_mut().release = Some(self.release(false));
    }
    pub(crate) fn start_prerelease(&self) {
        let mut r = self.release(false);
        r.prerelease = true;
        self.state.borrow_mut().release = Some(r);
    }
    pub(crate) fn asset_fault(&self, f: &'static str) {
        self.state.borrow_mut().asset_fault = Some(f);
    }
    pub(crate) fn start_draft_with_asset(&self) {
        let mut s = self.state.borrow_mut();
        s.release = Some(self.release(true));
        s.assets = vec![self.asset()];
    }
    pub(crate) fn fail_verify(&self) {
        self.state.borrow_mut().fail_verify = true;
    }
    fn release(&self, draft: bool) -> Release {
        Release {
            id: 7,
            draft,
            prerelease: false,
            tag_name: self.tag.clone(),
            target_commitish: self.commit.clone(),
            body: self.body.clone(),
        }
    }
    fn asset(&self) -> Asset {
        Asset {
            id: 11,
            name: super::super::ASSET.into(),
            state: "uploaded".into(),
            browser_download_url: self.url.clone(),
            size: self.bytes.len() as u64,
        }
    }
}
impl ReleaseClient for Client {
    fn get_tag_commit(&self, tag: &str) -> Result<Option<String>, PublisherError> {
        assert_eq!(tag, self.tag);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.tag_calls += 1;
        if s.fail_tag == Some(s.tag_calls) {
            Ok(Some("a".repeat(40)))
        } else {
            Ok(Some(self.commit.clone()))
        }
    }
    fn find_release(&self, tag: &str) -> Result<Option<Release>, PublisherError> {
        assert_eq!(tag, self.tag);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        Ok(s.release.clone())
    }
    fn create_draft(&self, r: CreateDraftRequest<'_>) -> Result<Release, PublisherError> {
        assert_eq!(r.tag, self.tag);
        assert_eq!(r.commit, self.commit);
        assert_eq!(r.body, self.body);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.create += 1;
        let v = self.release(true);
        s.release = Some(v.clone());
        if s.lost {
            Err(PublisherError::new("lost create"))
        } else {
            Ok(v)
        }
    }
    fn list_assets(&self, id: u64) -> Result<Vec<Asset>, PublisherError> {
        assert_eq!(id, 7);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.list_calls += 1;
        if s.fail_list == Some(s.list_calls) {
            return Err(PublisherError::new("fixture asset list failed"));
        }
        let mut v = s.assets.clone();
        if s.drift_asset == Some(s.list_calls) && !v.is_empty() {
            v[0].id += 1;
        }
        if let (Some(f), Some(a)) = (s.asset_fault, v.first_mut()) {
            match f {
                "name" => a.name = "other.json".into(),
                "state" => a.state = "new".into(),
                "size" => a.size += 1,
                "url" => a.browser_download_url.push_str("/wrong"),
                _ => unreachable!(),
            }
        }
        Ok(v)
    }
    fn upload_asset(&self, r: UploadAssetRequest<'_>) -> Result<Asset, PublisherError> {
        assert_eq!(r.release_id, 7);
        assert_eq!(r.name, super::super::ASSET);
        assert_eq!(r.size, self.bytes.len() as u64);
        assert_eq!(std::fs::read(r.file).unwrap(), self.bytes);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.upload += 1;
        let a = self.asset();
        s.assets = vec![a.clone()];
        if s.lost {
            Err(PublisherError::new("lost upload"))
        } else {
            Ok(a)
        }
    }
    fn verify_asset(&self, r: VerifyAssetRequest<'_>) -> Result<(), PublisherError> {
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.verifies += 1;
        let fail = s.fail_verify;
        drop(s);
        assert_eq!(r.expected_url, self.url);
        assert_eq!(r.sha256, self.sha256);
        assert_eq!(r.size, self.bytes.len() as u64);
        if fail || r.asset.id != 11 {
            return Err(PublisherError::new("authenticated bytes do not match"));
        }
        std::fs::write(r.output, &self.bytes).unwrap();
        Ok(())
    }
    fn publish_draft(&self, id: u64) -> Result<Release, PublisherError> {
        assert_eq!(id, 7);
        let mut s = self.state.borrow_mut();
        s.api += 1;
        s.patch += 1;
        if s.fail_patch {
            return Err(PublisherError::new("patch failed"));
        }
        let mut r = self.release(false);
        s.release = Some(r.clone());
        if s.wrong_patch_id {
            r.id = 8;
            return Ok(r);
        }
        if s.lost {
            Err(PublisherError::new("lost patch"))
        } else {
            Ok(r)
        }
    }
}
