use crate::github::discovery::{DiscoveryClient, DiscoveryHead, SetDiscoveryRequest};
use crate::github::{
    Asset, CreateDraftRequest, Release, ReleaseClient, UploadAssetRequest, VerifyAssetRequest,
};
use crate::test_support::ReadLag;
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
    release_reads: u64,
    listing_calls: u64,
    omit_listing: bool,
    list_calls: u64,
    lost: bool,
    fail_patch: bool,
    wrong_patch_id: bool,
    fail_tag: Option<u64>,
    drift_asset: Option<u64>,
    fail_list: Option<u64>,
    asset_fault: Option<&'static str>,
    fail_verify: bool,
    discovery: Option<DiscoveryHead>,
    discovery_gets: u64,
    discovery_sets: u64,
    lost_set: bool,
    drift_get: Option<u64>,
    drift_release: Option<u64>,
    foreign_lost: bool,
    /// Reads served the pre-write head after the write lands (API lag).
    discovery_lag: ReadLag<Option<DiscoveryHead>>,
    /// The write is refused and never lands.
    refuse_set: bool,
    /// Another writer lands a foreign head when this read begins.
    foreign_at: Option<u64>,
}

impl State {
    fn read_release(&mut self) -> Option<Release> {
        self.api += 1;
        self.release_reads += 1;
        let mut release = self.release.clone();
        if self.drift_release == Some(self.release_reads) {
            if let Some(value) = &mut release {
                value.body.push_str(" drift");
            }
        }
        release
    }
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
    pub(crate) fn fail_tag_after(&self, offset: u64) {
        let mut state = self.state.borrow_mut();
        state.fail_tag = Some(state.tag_calls + offset);
    }
    pub(crate) fn drift_release_after(&self, offset: u64) {
        let mut state = self.state.borrow_mut();
        state.drift_release = Some(state.release_reads + offset);
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
    pub(crate) fn discovery_counts(&self) -> (u64, u64) {
        let state = self.state.borrow();
        (state.discovery_gets, state.discovery_sets)
    }
    pub(crate) fn reset_api_observations(&self) {
        let mut state = self.state.borrow_mut();
        state.api = 0;
        state.discovery_gets = 0;
        state.discovery_sets = 0;
    }
    pub(crate) fn api_calls(&self) -> u64 {
        self.state.borrow().api
    }
    pub(crate) fn set_lost_discovery(&self, value: bool) {
        self.state.borrow_mut().lost_set = value;
    }
    pub(crate) fn foreign_winner_on_lost_set(&self) {
        let mut state = self.state.borrow_mut();
        state.lost_set = true;
        state.foreign_lost = true;
    }
    /// After the write lands, the next `reads` reads still see the old head.
    pub(crate) fn lag_discovery_reads(&self, reads: u64) {
        self.state.borrow().discovery_lag.set(reads);
    }
    pub(crate) fn refuse_discovery_set(&self) {
        self.state.borrow_mut().refuse_set = true;
    }
    pub(crate) fn foreign_head_at_get(&self, get: u64) {
        self.state.borrow_mut().foreign_at = Some(get);
    }
    pub(crate) fn drift_discovery_at(&self, get: u64) {
        self.state.borrow_mut().drift_get = Some(get);
    }
    pub(crate) fn set_discovery_head(&self, bytes: Vec<u8>) {
        self.state.borrow_mut().discovery = Some(DiscoveryHead {
            sha: "d".repeat(40),
            bytes,
        });
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
            browser_download_url: self.url.replace(&self.tag, "untagged-fixture"),
            size: self.bytes.len() as u64,
        }
    }
}
impl DiscoveryClient for Client {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError> {
        assert_eq!(branch, "main");
        let mut state = self.state.borrow_mut();
        state.discovery_gets += 1;
        if state.foreign_at == Some(state.discovery_gets) {
            state.discovery = Some(DiscoveryHead {
                sha: "e".repeat(40),
                bytes: b"{}\n".to_vec(),
            });
        }
        if let Some(stale) = state.discovery_lag.serve() {
            return Ok(stale);
        }
        let mut head = state.discovery.clone();
        if state.drift_get == Some(state.discovery_gets) {
            if let Some(value) = &mut head {
                value.sha = "e".repeat(40);
            } else {
                head = Some(DiscoveryHead {
                    sha: "e".repeat(40),
                    bytes: b"{}\n".to_vec(),
                });
            }
        }
        Ok(head)
    }
    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError> {
        assert_eq!(request.branch, "main");
        let mut state = self.state.borrow_mut();
        assert_eq!(
            request.expected_sha,
            state.discovery.as_ref().map(|head| head.sha.as_str())
        );
        state.discovery_sets += 1;
        if state.refuse_set {
            return Err(PublisherError::new("refused discovery PUT"));
        }
        state.discovery_lag.landed(state.discovery.clone());
        state.discovery = Some(if state.foreign_lost {
            DiscoveryHead {
                sha: "e".repeat(40),
                bytes: b"{}\n".to_vec(),
            }
        } else {
            DiscoveryHead {
                sha: "c".repeat(40),
                bytes: request.bytes.to_vec(),
            }
        });
        if state.lost_set {
            Err(PublisherError::new("lost discovery PUT"))
        } else {
            Ok(())
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
        let mut state = self.state.borrow_mut();
        state.listing_calls += 1;
        let release = state.read_release();
        Ok(if state.omit_listing { None } else { release })
    }
    fn get_release(&self, id: u64) -> Result<Option<Release>, PublisherError> {
        Ok(self
            .state
            .borrow_mut()
            .read_release()
            .filter(|release| release.id == id))
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
        assert!(r
            .url_policy
            .matches(&r.asset.browser_download_url, r.expected_url));
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
        for asset in &mut s.assets {
            asset.browser_download_url.clone_from(&self.url);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog_publish::fixture::FlowFixture;

    #[test]
    fn publication_uses_known_id_when_listing_omits_the_created_release() {
        let fixture = FlowFixture::new();
        fixture.client.state.borrow_mut().omit_listing = true;
        assert!(fixture.client.get_release(7).unwrap().is_none());
        let receipt = fixture.publish().unwrap();
        assert_eq!(receipt.release_id, 7);
        assert_eq!(fixture.client.mutations(), (1, 1, 1));
        assert_eq!(fixture.client.state.borrow().listing_calls, 1);
        assert!(!fixture.client.get_release(7).unwrap().unwrap().draft);
        assert!(fixture
            .client
            .find_release(&fixture.client.tag)
            .unwrap()
            .is_none());
        assert!(fixture.client.get_release(8).unwrap().is_none());
        assert!(fixture
            .directory
            .join(super::super::super::RECEIPT)
            .exists());
    }
}
