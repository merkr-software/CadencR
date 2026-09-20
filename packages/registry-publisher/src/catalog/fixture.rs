use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;

use sha2::{Digest as _, Sha256};

use crate::binding::{build_publication_binding, compact_artifacts, MirrorReceipt};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

pub(super) enum Mode {
    Good,
    WrongDigest,
    WrongSize,
}

pub(super) struct FixtureDownloader {
    pub(super) values: HashMap<String, Vec<u8>>,
    pub(super) calls: Cell<u64>,
    pub(super) requests: RefCell<Vec<String>>,
    pub(super) mode: Mode,
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

pub(super) struct Fixture {
    _root: tempfile::TempDir,
    pub(super) manifest: PathBuf,
    pub(super) receipt_files: Vec<PathBuf>,
    pub(super) downloader: FixtureDownloader,
}

pub(super) fn build(count: usize, mode: Mode) -> Fixture {
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
