use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;

use sha2::{Digest as _, Sha256};

use crate::binding::{build_publication_binding, compact_artifacts, MirrorReceipt};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

pub(crate) enum Mode {
    Good,
    WrongDigest,
    WrongSize,
}

pub(crate) struct FixtureDownloader {
    pub(crate) values: HashMap<String, Vec<u8>>,
    pub(crate) calls: Cell<u64>,
    pub(crate) requests: RefCell<Vec<String>>,
    pub(crate) mode: Mode,
}

impl Downloader for FixtureDownloader {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        self.calls.set(self.calls.get() + 1);
        self.requests.borrow_mut().push(request.url.to_owned());
        let bytes = self
            .values
            .get(request.url)
            .ok_or_else(|| PublisherError::new("unexpected catalog fixture URL"))?;
        std::fs::write(&request.output, bytes)
            .map_err(|error| PublisherError::io("write catalog fixture", error))?;
        let mut result = Downloaded {
            sha256: crate::hex(&Sha256::digest(bytes)),
            size: bytes.len() as u64,
        };
        match self.mode {
            Mode::Good => {}
            Mode::WrongDigest => result.sha256 = "0".repeat(64),
            Mode::WrongSize => result.size += 1,
        }
        Ok(result)
    }
}

impl FixtureDownloader {
    pub(crate) fn insert(&mut self, url: String, bytes: Vec<u8>) {
        self.values.insert(url, bytes);
    }
}

pub(crate) struct Fixture {
    _root: tempfile::TempDir,
    pub(crate) manifest: PathBuf,
    pub(crate) receipt_files: Vec<PathBuf>,
    pub(crate) downloader: FixtureDownloader,
}

impl Fixture {
    pub(crate) fn directory(&self) -> &std::path::Path {
        self.manifest.parent().unwrap()
    }
}

pub(crate) fn build(count: usize, mode: Mode) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let mut publications = Vec::new();
    let mut receipt_files = Vec::new();
    let mut public = HashMap::new();
    for index in 0..count {
        let id = format!("acme-{index}");
        let source_url = format!("https://github.com/acme/{id}/releases/download/v1/provider.tgz");
        let archive = format!("archive-{index}").into_bytes();
        let submission = serde_json::json!({
            "schema_version":1,
            "package":{"agent":{"id":id,"name":"Acme","version":"1.0.0","description":"Agent","license":"MIT","repository":format!("https://github.com/acme/{id}"),"distribution":{"binary":{"linux-x86_64":{"archive":source_url,"cmd":"bin/provider","sha256":crate::hex(&Sha256::digest(&archive))}}}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.12.0"},"assets":{"icon":"icon.svg","readme":"README.md","license":"LICENSE"}}},
            "source":{"repository":format!("https://github.com/acme/{id}"),"commit":"a".repeat(40),"tag":"v1"},"changelog":"Release"
        });
        let submission_name = format!("submission-{index}.json");
        std::fs::write(
            root.path().join(&submission_name),
            serde_json::to_vec(&submission).unwrap(),
        )
        .unwrap();
        let directory_name = format!("published-{index}");
        let directory = root.path().join(&directory_name);
        let source = FixtureDownloader {
            values: HashMap::from([(source_url, archive)]),
            calls: Cell::new(0),
            requests: RefCell::new(Vec::new()),
            mode: Mode::Good,
        };
        let staged =
            crate::stage::stage_loaded(&submission, "cadencr/registry", &directory, &source)
                .unwrap();
        let commit = "b".repeat(40);
        let binding =
            build_publication_binding(&staged, "cadencr/registry", &commit, &directory).unwrap();
        let mirror = MirrorReceipt {
            schema_version: 1,
            status: "draft_verified".into(),
            repository: "cadencr/registry".into(),
            registry_commit: commit.clone(),
            release_id: index as u64 + 1,
            release_tag: binding.tag.clone(),
            plan_sha256: binding.plan_sha256.clone(),
            artifacts: compact_artifacts(&binding.expected),
        };
        crate::receipt::publish_canonical_receipt(
            &directory,
            crate::binding::MIRROR_RECEIPT,
            &mirror,
        )
        .unwrap();
        let receipt = crate::binding::build_publication_receipt()
            .binding(&binding)
            .repository("cadencr/registry")
            .registry_commit(&commit)
            .release_id(mirror.release_id)
            .call();
        let receipt_file = directory.join(crate::binding::PUBLICATION_RECEIPT);
        crate::receipt::publish_canonical_receipt(
            &directory,
            crate::binding::PUBLICATION_RECEIPT,
            &receipt,
        )
        .unwrap();
        receipt_files.push(receipt_file);
        for artifact in binding.expected {
            let bytes = match artifact.source {
                crate::binding::ArtifactSource::File(path) => std::fs::read(path).unwrap(),
                crate::binding::ArtifactSource::Bytes(bytes) => bytes,
            };
            public.insert(artifact.expected_url, bytes);
        }
        publications.push(serde_json::json!({"submission":submission_name,"directory":directory_name,"registry_commit":commit}));
    }
    let manifest = root.path().join("manifest.json");
    std::fs::write(&manifest, serde_json::to_vec(&serde_json::json!({"schema_version":1,"repository":"cadencr/registry","publications":publications})).unwrap()).unwrap();
    Fixture {
        _root: root,
        manifest,
        receipt_files,
        downloader: FixtureDownloader {
            values: public,
            calls: Cell::new(0),
            requests: RefCell::new(Vec::new()),
            mode,
        },
    }
}

impl Fixture {
    /// Synthetic signed history; historical URLs are intentionally absent from
    /// the downloader, so any accidental historical fetch fails the test.
    pub(crate) fn add_baseline(&self, count: usize) {
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&self.manifest).unwrap()).unwrap();
        let mut template: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        template["agent"]["id"] = "historical".into();
        template["agent"]["description"] = "x".repeat(10_000).into();
        let packages = (1..=count)
            .map(|version| {
                let mut package = template.clone();
                package["agent"]["version"] = format!("1.0.{version}").into();
                package
            })
            .collect();
        let output = std::process::Command::new("node").args(["-e", "const now=Date.now();console.log(JSON.stringify([new Date(now-120000).toISOString().replace(/\\.\\d{3}Z$/,'Z'),new Date(now+86400000).toISOString().replace(/\\.\\d{3}Z$/,'Z')]))"]).output().unwrap();
        assert!(output.status.success());
        let window: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        let payload = cadencr_registry_core::prepare_publication_index()
            .packages(packages)
            .generated_at(&window[0])
            .expires_at(&window[1])
            .call()
            .unwrap();
        let private = self.directory().join("fixture-private.pem");
        std::fs::write(&private, "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n").unwrap();
        let signed =
            cadencr_registry_core::sign_prepared_index(payload, &private, "test-key").unwrap();
        std::fs::write(self.directory().join("previous-index.json"), signed).unwrap();
        std::fs::write(self.directory().join("public-key.pem"), "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n").unwrap();
        manifest["baseline"] = serde_json::json!({"previous_index":"previous-index.json","public_key":"public-key.pem","key_id":"test-key"});
        std::fs::write(&self.manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    pub(crate) fn remove_archives(&self) {
        for receipt in &self.receipt_files {
            let value: crate::binding::PublicationReceipt =
                serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
            for artifact in value.artifacts {
                if artifact.name != "publication-plan.json" {
                    std::fs::remove_file(receipt.parent().unwrap().join(artifact.name)).unwrap();
                }
            }
        }
    }
}
