//! Real JS and Rust orchestration switch ownership of exact disk state and one remote.
use super::fixture::{Fixture, REPOSITORY};
use super::*;
use crate::github::discovery::{DiscoveryHead, SetDiscoveryRequest};
use crate::github::{Asset, CreateDraftRequest, Release, UploadAssetRequest, VerifyAssetRequest};
use crate::{DownloadRequest, Downloaded};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct Remote {
    _process: OwnedProcess,
    control: String,
    base: String,
    http: reqwest::blocking::Client,
    github: GitHubClient,
}
struct OwnedProcess(Child);
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if self
            .0
            .try_wait()
            .expect("inspect owned handoff server")
            .is_none()
        {
            self.0.kill().expect("stop owned handoff server");
        }
        self.0.wait().expect("reap owned handoff server");
    }
}
impl Remote {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut process = Command::new("node")
            .arg(
                root.join("tooling/marketplace-registry/tests/helpers/pipeline-handoff-server.mjs"),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = process.stdout.take().unwrap();
        let process = OwnedProcess(process);
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = send.send(result);
        });
        let line = receive
            .recv_timeout(Duration::from_secs(10))
            .expect("bounded Node startup")
            .unwrap();
        let address: Value = serde_json::from_str(&line).unwrap();
        let base = address["remote"].as_str().unwrap().to_owned();
        Self {
            _process: process,
            control: address["control"].as_str().unwrap().into(),
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
    fn js(&self, fixture: &Fixture) -> Value {
        self.control(json!({"action":"run", "request":fixture.request,"directory":fixture.state,"privateKey":fixture.private}))
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
fn assert_managed_only_trace(remote: &Remote, previous: &Value) {
    let current = remote.control(json!({"action":"stats"}));
    let offset = previous["requests"].as_array().unwrap().len();
    for release in previous["releaseRecords"].as_array().unwrap() {
        let retained = current["releaseRecords"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == release["id"]);
        assert_eq!(retained, Some(release), "existing release record changed");
    }
    let providers: Vec<u64> = previous["releaseRecords"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|release| {
            !release["tag_name"]
                .as_str()
                .unwrap()
                .starts_with("catalog-")
        })
        .map(|release| release["id"].as_u64().unwrap())
        .collect();
    assert!(
        !providers.is_empty(),
        "existing provider release must be retained"
    );
    for request in &current["requests"].as_array().unwrap()[offset..] {
        let path = request["path"].as_str().unwrap();
        assert!(
            !path.starts_with("/public/acme/provider/"),
            "author download after retirement: {request}"
        );
        if request["method"] != "GET" {
            for id in &providers {
                let resource = format!("/releases/{id}");
                assert!(
                    !path.ends_with(&resource) && !path.contains(&format!("{resource}/")),
                    "existing provider release mutated: {request}"
                );
            }
        }
    }
}
fn assert_resume_mutations(remote: &Remote, previous: &Value, interruption: &str) {
    let current = remote.control(json!({"action":"stats"}));
    let offset = previous["requests"].as_array().unwrap().len();
    let mutations: Vec<Value> = current["requests"].as_array().unwrap()[offset..]
        .iter()
        .filter(|request| request["method"] != "GET")
        .map(|request| json!([request["method"], request["path"]]))
        .collect();
    if interruption != "provider" {
        assert!(
            mutations.is_empty(),
            "completed remote state must not be rewritten: {mutations:?}"
        );
        assert_eq!(current["discovery"], previous["discovery"]);
        return;
    }
    let catalog = current["releaseRecords"]
        .as_array()
        .unwrap()
        .iter()
        .find(|release| {
            release["tag_name"]
                .as_str()
                .unwrap()
                .starts_with("catalog-")
        })
        .expect("only the catalog is created after interrupted provider verification");
    let id = catalog["id"].as_u64().unwrap();
    let expected = vec![
        json!(["POST", "/api/repos/acme/registry/git/refs"]),
        json!(["POST", "/api/repos/acme/registry/releases"]),
        json!([
            "POST",
            format!("/uploads/repos/acme/registry/releases/{id}/assets")
        ]),
        json!(["PATCH", format!("/api/repos/acme/registry/releases/{id}")]),
        json!([
            "PUT",
            "/api/repos/acme/registry/contents/managed-index.json"
        ]),
    ];
    assert_eq!(
        mutations, expected,
        "only five ordered catalog/discovery mutations are permitted"
    );
    assert_eq!(
        current["releaseRecords"].as_array().unwrap().len(),
        previous["releaseRecords"].as_array().unwrap().len() + 1
    );
}
fn snapshot(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, dir: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(root, &path, result);
            } else {
                result.insert(
                    path.strip_prefix(root).unwrap().into(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut result = BTreeMap::new();
    visit(directory, directory, &mut result);
    result
}
fn assert_preserved(before: &BTreeMap<PathBuf, Vec<u8>>, state: &Path) {
    let after = snapshot(state);
    for (path, bytes) in before {
        assert_eq!(after.get(path), Some(bytes), "preserve {}", path.display());
    }
}
fn assert_complete(state: &Path) {
    let files = snapshot(state);
    for suffix in [
        "pipeline-request.json",
        "publication-manifest.json",
        "staging-receipt.json",
        "mirror-receipt.json",
        "publication-receipt.json",
        "managed-index.json",
        "catalog-publication-receipt.json",
        "discovery-receipt.json",
    ] {
        assert!(
            files.keys().any(|path| path.ends_with(suffix)),
            "missing {suffix}: {:?}",
            files.keys()
        );
    }
    assert!(!state.join(".pipeline.lock").exists());
}
#[test]
fn cross_language_completed_replay_and_interrupted_resume_preserve_protected_state() {
    for js_first in [true, false] {
        for interruption in ["none", "provider", "discovery"] {
            let fixture = Fixture::new();
            let remote = Remote::new();
            let reviewed_request = std::fs::read(&fixture.request).unwrap();
            remote.control(json!({"action":"configure", "publicUnavailable":interruption=="provider", "rawUnavailable":interruption=="discovery"}));
            let ok = if js_first {
                remote.js(&fixture)["ok"] == true
            } else {
                remote.rust(&fixture).is_ok()
            };
            assert_eq!(
                ok,
                interruption == "none",
                "first implementation {js_first}/{interruption}"
            );
            if interruption == "provider" {
                assert!(!fixture.state.join("managed-index.json").exists());
                assert!(!fixture.state.join("discovery-receipt.json").exists());
            }
            if interruption == "discovery" {
                assert!(fixture.state.join("managed-index.json").exists());
                assert!(!fixture.state.join("discovery-receipt.json").exists());
            }
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
            if js_first {
                remote.rust(&fixture).unwrap();
            } else {
                let result = remote.js(&fixture);
                assert_eq!(result["ok"], true, "{result}");
            }
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
            let result = remote.js(&fixture);
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(snapshot(&fixture.state), complete);
            assert_eq!(std::fs::read(&fixture.request).unwrap(), reviewed_request);
            assert_eq!(remote.writes(), writes);
            assert_managed_only_trace(&remote, &trace);
        }
    }
}
#[test]
fn cross_language_fresh_managed_recovery_and_tampered_receipt_fail_closed() {
    for js_first in [true, false] {
        let mut fixture = Fixture::new();
        let remote = Remote::new();
        if js_first {
            let result = remote.js(&fixture);
            assert_eq!(result["ok"], true, "{result}");
        } else {
            remote.rust(&fixture).unwrap();
        }
        let signed = std::fs::read(fixture.state.join("managed-index.json")).unwrap();
        let trace = remote.control(json!({"action":"stats"}));
        remote.control(json!({"action":"configure", "retireSources":true}));
        fixture.state = fixture.state.parent().unwrap().join("fresh-state");
        let writes = remote.writes();
        if js_first {
            remote.rust(&fixture).unwrap();
        } else {
            let result = remote.js(&fixture);
            assert_eq!(result["ok"], true, "{result}");
        }
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
            let result = remote.js(&fixture);
            assert_eq!(result["ok"], false, "{result}");
            assert_eq!(remote.writes(), writes);
            assert_eq!(snapshot(&fixture.state), before);
            // Restore only this test-owned tamper probe, not repository work.
            std::fs::write(file, bytes).unwrap();
        }
    }
}

#[test]
fn noncanonical_manifest_documents_stricter_js_boundary_without_writes() {
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
    let result = remote.js(&fixture);
    assert_eq!(result["ok"], false, "{result}");
    assert!(result["error"]
        .as_str()
        .unwrap()
        .contains("existing publication manifest conflicts"));
    assert_eq!(snapshot(&fixture.state), before);
    assert_eq!(remote.writes(), writes);
}
