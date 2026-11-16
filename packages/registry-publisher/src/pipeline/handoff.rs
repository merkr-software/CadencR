//! Archived legacy-produced state, explicitly timestamp-rebased, resumes in Rust.
//! This is independent compatibility evidence, not live reverse-language parity.
use super::fixture::{Fixture, REPOSITORY};
use super::*;
use crate::github::discovery::{DiscoveryHead, SetDiscoveryRequest};
use crate::github::{Asset, CreateDraftRequest, Release, UploadAssetRequest, VerifyAssetRequest};
use crate::{DownloadRequest, Downloaded};
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;

mod assertions;
mod server;
use assertions::*;

struct Remote {
    _server: server::Server,
    control: String,
    base: String,
    http: reqwest::blocking::Client,
    github: GitHubClient,
}
impl Remote {
    fn new() -> Self {
        let server = server::Server::start();
        let base = server.base.clone();
        Self {
            control: format!("{base}/control"),
            _server: server,
            github: GitHubClient::fixture(
                REPOSITORY,
                "handoff-token",
                format!("{base}/api"),
                format!("{base}/uploads"),
            )
            .unwrap(),
            base,
            http: reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(25))
                .build()
                .unwrap(),
        }
    }
    fn control(&self, input: Value) -> Value {
        serde_json::from_slice(
            &self
                .http
                .post(&self.control)
                .header("content-type", "application/json")
                .body(serde_json::to_vec(&input).unwrap())
                .send()
                .unwrap()
                .error_for_status()
                .unwrap()
                .bytes()
                .unwrap(),
        )
        .unwrap()
    }
    fn legacy(&self, fixture: &Fixture, interruption: &str) -> bool {
        let capture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/legacy-v1/pipeline")
            .join(format!("{interruption}.json.gz"));
        let hashes: Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/legacy-v1/pipeline/hashes.json"
        ))
        .unwrap();
        let result = self.control(json!({"action":"load", "capture":capture,
            "hashes":hashes[format!("{interruption}.json.gz")],
            "directory":fixture.request.parent().unwrap()}));
        let ok = result["ok"].as_bool().unwrap();
        assert_eq!(ok, interruption == "none", "archived legacy outcome");
        if !ok {
            assert_eq!(
                result["error"],
                "archive download: server returned an unexpected status"
            );
        }
        ok
    }
    fn rust(&self, fixture: &Fixture) -> Result<PipelineReceipt, PublisherError> {
        run(&fixture.prepare()?, self, self, self)
    }
    fn writes(&self) -> u64 {
        self.control(json!({"action":"stats"}))["writes"]
            .as_u64()
            .unwrap()
    }
    fn mapped(
        &self,
        request: DownloadRequest<'_>,
        path: &str,
        authenticated: bool,
    ) -> Result<Downloaded, PublisherError> {
        let mut get = self.http.get(format!("{}{path}", self.base));
        if authenticated {
            get = get.bearer_auth("handoff-token");
        }
        let response = get
            .send()
            .map_err(|error| PublisherError::io("handoff HTTP", error))?;
        crate::download::download_authenticated_asset(response, request)
    }
}
impl PipelineClient for Remote {
    fn ensure_tag(&self, tag: &str, commit: &str) -> Result<(), PublisherError> {
        self.github.ensure_publication_tag(tag, commit)
    }
}
impl ReleaseClient for Remote {
    fn get_tag_commit(&self, tag: &str) -> Result<Option<String>, PublisherError> {
        self.github.get_tag_commit(tag)
    }
    fn find_release(&self, tag: &str) -> Result<Option<Release>, PublisherError> {
        self.github.find_release(tag)
    }
    fn get_release(&self, id: u64) -> Result<Option<Release>, PublisherError> {
        self.github.get_release(id)
    }
    fn create_draft(&self, request: CreateDraftRequest<'_>) -> Result<Release, PublisherError> {
        self.github.create_draft(request)
    }
    fn list_assets(&self, id: u64) -> Result<Vec<Asset>, PublisherError> {
        self.github.list_assets(id)
    }
    fn upload_asset(&self, request: UploadAssetRequest<'_>) -> Result<Asset, PublisherError> {
        self.github.upload_asset(request)
    }
    fn publish_draft(&self, id: u64) -> Result<Release, PublisherError> {
        self.github.publish_draft(id)
    }
    fn verify_asset(&self, request: VerifyAssetRequest<'_>) -> Result<(), PublisherError> {
        assert_eq!(request.asset.browser_download_url, request.expected_url);
        let result = self.mapped(
            DownloadRequest {
                url: request.expected_url,
                sha256: request.sha256,
                output: request.output.to_path_buf(),
                max_bytes: request.size,
            },
            &format!(
                "/api/repos/{REPOSITORY}/releases/assets/{}",
                request.asset.id
            ),
            true,
        )?;
        if result.size != request.size {
            return Err(PublisherError::new("handoff asset size mismatch"));
        }
        Ok(())
    }
}
impl DiscoveryClient for Remote {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError> {
        self.github.get_discovery(branch)
    }
    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError> {
        self.github.set_discovery(request)
    }
}
impl Downloader for Remote {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        let parsed = url::Url::parse(request.url).unwrap();
        let prefix = match parsed.host_str().unwrap() {
            "github.com" => "/public",
            "raw.githubusercontent.com" => "/raw",
            host => panic!("unexpected handoff destination {host}"),
        };
        let path = format!("{prefix}{}", parsed.path());
        self.mapped(request, &path, false)
    }
}
#[test]
fn archived_legacy_and_rust_resume_preserve_protected_state() {
    for legacy_first in [true, false] {
        for interruption in ["none", "provider", "discovery"] {
            let fixture = Fixture::new();
            let remote = Remote::new();
            remote.control(json!({"action":"configure", "publicUnavailable":interruption=="provider", "rawUnavailable":interruption=="discovery"}));
            let ok = if legacy_first {
                remote.legacy(&fixture, interruption)
            } else {
                remote.rust(&fixture).is_ok()
            };
            assert_eq!(
                ok,
                interruption == "none",
                "first implementation {legacy_first}/{interruption}"
            );
            if interruption == "provider" {
                assert!(!fixture.state.join("managed-index.json").exists());
                assert!(!fixture.state.join("discovery-receipt.json").exists());
            }
            if interruption == "discovery" {
                assert!(fixture.state.join("managed-index.json").exists());
                assert!(!fixture.state.join("discovery-receipt.json").exists());
            }
            let reviewed_request = std::fs::read(&fixture.request).unwrap();
            let prepared = fixture.prepare().unwrap();
            let plan_file = prepared.entries[0].directory.join("publication-plan.json");
            std::fs::write(
                &plan_file,
                serde_json::to_vec_pretty(&prepared.entries[0].plan).unwrap(),
            )
            .unwrap();
            let before = snapshot(&fixture.state);
            let writes = remote.writes();
            let trace = remote.control(json!({"action":"stats"}));
            remote.control(json!({"action":"configure", "retireSources":true}));
            remote.rust(&fixture).unwrap();
            assert_managed_only_trace(&remote, &trace);
            assert_resume_mutations(&remote, &trace, interruption);
            assert_preserved(&before, &fixture.state);
            assert_complete(&fixture.state);
            if interruption != "provider" {
                assert_eq!(remote.writes(), writes);
            }
            let complete = snapshot(&fixture.state);
            let writes = remote.writes();
            remote.rust(&fixture).unwrap();
            assert_eq!(snapshot(&fixture.state), complete);
            assert_eq!(std::fs::read(&fixture.request).unwrap(), reviewed_request);
            assert_eq!(remote.writes(), writes);
            assert_managed_only_trace(&remote, &trace);
        }
    }
}
#[test]
fn archived_legacy_and_rust_fresh_managed_recovery_and_tamper_fail_closed() {
    for legacy_first in [true, false] {
        let mut fixture = Fixture::new();
        let remote = Remote::new();
        if legacy_first {
            assert!(remote.legacy(&fixture, "none"));
        } else {
            remote.rust(&fixture).unwrap();
        }
        let signed = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
        let trace = remote.control(json!({"action":"stats"}));
        remote.control(json!({"action":"configure", "retireSources":true}));
        fixture.state = fixture.state.parent().unwrap().join("fresh-state");
        let writes = remote.writes();
        remote.rust(&fixture).unwrap();
        assert_managed_only_trace(&remote, &trace);
        assert_complete(&fixture.state);
        assert_eq!(
            std::fs::read(fixture.state.join("managed-index.json")).unwrap(),
            signed
        );
        assert_eq!(remote.writes(), writes);
        for name in ["catalog-publication-receipt.json", "discovery-receipt.json"] {
            let file = fixture.state.join(name);
            let bytes = std::fs::read(&file).unwrap();
            std::fs::write(&file, b"{}").unwrap();
            let before = snapshot(&fixture.state);
            assert!(remote.rust(&fixture).is_err());
            assert_eq!(remote.writes(), writes);
            assert_eq!(snapshot(&fixture.state), before);
            // Restore only this test-owned tamper probe, not repository work.
            std::fs::write(file, bytes).unwrap();
        }
    }
}

#[test]
fn noncanonical_manifest_is_preserved_without_writes() {
    let fixture = Fixture::new();
    let remote = Remote::new();
    remote.rust(&fixture).unwrap();
    let manifest_file = fixture.state.join("publication-manifest.json");
    let manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_file).unwrap()).unwrap();
    std::fs::write(manifest_file, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    let before = snapshot(&fixture.state);
    let writes = remote.writes();
    remote.rust(&fixture).unwrap();
    assert_eq!(snapshot(&fixture.state), before);
    assert_eq!(remote.writes(), writes);
}

#[test]
fn archived_legacy_boundary_observations_are_pinned() {
    use sha2::{Digest as _, Sha256};
    let bytes = include_bytes!("../../tests/fixtures/legacy-v1/pipeline/observations.json");
    let hashes: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/legacy-v1/pipeline/hashes.json"
    ))
    .unwrap();
    assert_eq!(
        crate::hex(&Sha256::digest(bytes)),
        hashes["observations.json"]
    );
    let evidence: Value = serde_json::from_slice(bytes).unwrap();
    for name in ["initial", "replay", "fresh"] {
        assert_eq!(evidence[name]["ok"], true);
    }
    assert_eq!(evidence["writes_before"], evidence["writes_after"]);
    for (file, error) in [
        (
            "catalog-publication-receipt.json",
            "existing catalog receipt conflicts",
        ),
        (
            "discovery-receipt.json",
            "existing discovery receipt conflicts",
        ),
    ] {
        assert_eq!(evidence["tamper"][file]["result"]["ok"], false);
        assert_eq!(evidence["tamper"][file]["result"]["error"], error);
        assert_eq!(evidence["tamper"][file]["unchanged_disk"], true);
    }
    assert_eq!(evidence["noncanonical"]["ok"], false);
    assert_eq!(
        evidence["noncanonical"]["error"],
        "existing publication manifest conflicts"
    );
}
