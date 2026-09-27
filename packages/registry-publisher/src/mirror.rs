use crate::binding::{
    build_publication_binding, compact_artifacts, read_mirror_receipt, MirrorReceipt,
};
use crate::github::ReleaseClient;
use crate::publication_local::{self, RefusingDownloader};
use crate::stage;
use crate::{PublisherError, StageRequest};

pub(crate) fn mirror(
    request: StageRequest<'_>,
    registry_commit: &str,
    client: &impl ReleaseClient,
) -> Result<MirrorReceipt, PublisherError> {
    crate::validate_registry_commit(registry_commit)?;
    let lock = publication_local::acquire(request.directory, "mirror")?;
    let result = mirror_locked(request, registry_commit, client);
    match result {
        Ok(receipt) => {
            lock.release(None)?;
            Ok(receipt)
        }
        Err(error) => {
            lock.release(Some(error))?;
            unreachable!("release returns the primary error")
        }
    }
}

fn mirror_locked(
    request: StageRequest<'_>,
    registry_commit: &str,
    client: &impl ReleaseClient,
) -> Result<MirrorReceipt, PublisherError> {
    let repository = request.repository;
    let directory = request.directory;
    let staged = stage::stage(request, &RefusingDownloader::for_operation("mirror"))?;
    let binding = build_publication_binding(&staged, repository, registry_commit, directory)?;
    let prior = read_mirror_receipt(directory, &binding, repository, registry_commit)?;
    verify_tag(client, &binding.tag, registry_commit)?;
    let release = resolve_release(client, &binding, registry_commit, prior.as_ref())?;
    let mut assets = validated_assets(client.list_assets(release.id)?, &binding.expected, false)?;
    verify_present(client, &assets, &binding.expected, directory)?;
    let missing: Vec<String> = binding
        .expected
        .iter()
        .filter(|item| !assets.iter().any(|asset| asset.name == item.name))
        .map(|item| item.name.clone())
        .collect();
    let had_missing = !missing.is_empty();
    for name in missing {
        if assets.iter().any(|asset| asset.name == name) {
            continue;
        }
        let artifact = binding
            .expected
            .iter()
            .find(|item| item.name == name)
            .expect("missing names originate in expected artifacts");
        revalidate_release(client, &release, registry_commit, &binding.body)?;
        verify_tag(client, &binding.tag, registry_commit)?;
        validate_local_artifact(artifact)?;
        let _ = upload_one(client, release.id, artifact, &binding.expected, directory)?;
        // Detect foreign assets before the next mutation, retaining this snapshot.
        assets = validated_assets(client.list_assets(release.id)?, &binding.expected, false)?;
    }
    let final_assets = validated_assets(client.list_assets(release.id)?, &binding.expected, true)?;
    if had_missing || final_assets != assets {
        verify_present(client, &final_assets, &binding.expected, directory)?;
    }
    revalidate_release(client, &release, registry_commit, &binding.body)?;
    verify_tag(client, &binding.tag, registry_commit)?;
    let receipt = MirrorReceipt {
        schema_version: 1,
        status: "draft_verified".to_owned(),
        repository: repository.to_owned(),
        registry_commit: registry_commit.to_owned(),
        release_id: release.id,
        release_tag: binding.tag,
        plan_sha256: binding.plan_sha256,
        artifacts: compact_artifacts(&binding.expected),
    };
    publish_receipt(directory, &receipt)?;
    Ok(receipt)
}

pub(crate) mod release;
use release::{resolve_release, revalidate_release, verify_tag};

pub(crate) mod artifacts;
use artifacts::{
    publish_receipt, upload_one, validate_local_artifact, validated_assets, verify_present,
};

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::{Cell, RefCell};
    use std::path::Path;

    use serde_json::json;
    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::binding::MIRROR_RECEIPT;
    use crate::github::{
        Asset, CreateDraftRequest, Release, UploadAssetRequest, VerifyAssetRequest,
    };
    use crate::{DownloadRequest, Downloaded, Downloader, StageRequest};

    const REPOSITORY: &str = "cadencr/registry";
    const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ARCHIVE: &[u8] = b"archive";

    struct FixtureDownloader;

    impl Downloader for FixtureDownloader {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            std::fs::write(&request.output, ARCHIVE)
                .map_err(|error| PublisherError::io("write fixture", error))?;
            Ok(Downloaded {
                sha256: crate::hex(&Sha256::digest(ARCHIVE)),
                size: ARCHIVE.len() as u64,
            })
        }
    }

    #[derive(Default)]
    pub(crate) struct FakeClient {
        pub(crate) release: RefCell<Option<Release>>,
        pub(crate) assets: RefCell<Vec<(Asset, Vec<u8>)>>,
        pub(crate) creates: Cell<u64>,
        pub(crate) finds: Cell<u64>,
        pub(crate) uploads: Cell<u64>,
        pub(crate) asset_lists: Cell<u64>,
        pub(crate) publishes: Cell<u64>,
        pub(crate) verifications: Cell<u64>,
        pub(crate) tag_commit: RefCell<Option<String>>,
        pub(crate) tag_checks: Cell<u64>,
        pub(crate) drift_tag_after: Option<u64>,
        pub(crate) lose_create: bool,
        pub(crate) lose_upload: bool,
        pub(crate) lose_publish: bool,
        pub(crate) fail_publish: bool,
        pub(crate) promote_on_second_find: bool,
        pub(crate) corrupt_verify: bool,
        pub(crate) drift_assets_after: Cell<Option<u64>>,
    }

    impl ReleaseClient for FakeClient {
        fn get_tag_commit(&self, _: &str) -> Result<Option<String>, PublisherError> {
            self.tag_checks.set(self.tag_checks.get() + 1);
            if self
                .drift_tag_after
                .is_some_and(|limit| self.tag_checks.get() >= limit)
            {
                return Ok(Some("a".repeat(40)));
            }
            Ok(self.tag_commit.borrow().clone())
        }

        fn find_release(&self, _: &str) -> Result<Option<Release>, PublisherError> {
            self.finds.set(self.finds.get() + 1);
            let mut release = self.release.borrow().clone();
            if self.promote_on_second_find && self.finds.get() >= 2 {
                if let Some(value) = &mut release {
                    value.draft = false;
                }
            }
            Ok(release)
        }

        fn create_draft(&self, request: CreateDraftRequest<'_>) -> Result<Release, PublisherError> {
            self.creates.set(self.creates.get() + 1);
            let release = Release {
                id: 7,
                draft: true,
                prerelease: false,
                tag_name: request.tag.to_owned(),
                target_commitish: request.commit.to_owned(),
                body: request.body.to_owned(),
            };
            self.release.replace(Some(release.clone()));
            if self.lose_create {
                Err(PublisherError::new("lost create response"))
            } else {
                Ok(release)
            }
        }

        fn list_assets(&self, _: u64) -> Result<Vec<Asset>, PublisherError> {
            self.asset_lists.set(self.asset_lists.get() + 1);
            if self
                .drift_assets_after
                .get()
                .is_some_and(|limit| self.asset_lists.get() >= limit)
            {
                if let Some((asset, _)) = self.assets.borrow_mut().first_mut() {
                    asset.id = 999;
                }
            }
            Ok(self
                .assets
                .borrow()
                .iter()
                .map(|(asset, _)| asset.clone())
                .collect())
        }

        fn upload_asset(&self, request: UploadAssetRequest<'_>) -> Result<Asset, PublisherError> {
            self.uploads.set(self.uploads.get() + 1);
            let bytes = std::fs::read(request.file)
                .map_err(|error| PublisherError::io("read upload fixture", error))?;
            let asset = Asset {
                id: self.uploads.get(),
                name: request.name.to_owned(),
                state: "uploaded".to_owned(),
                browser_download_url: format!(
                    "https://github.com/{REPOSITORY}/releases/download/provider-acme-v1.0.0/{}",
                    request.name
                ),
                size: bytes.len() as u64,
            };
            self.assets.borrow_mut().push((asset.clone(), bytes));
            if self.lose_upload {
                Err(PublisherError::new("lost upload response"))
            } else {
                Ok(asset)
            }
        }

        fn publish_draft(&self, _: u64) -> Result<Release, PublisherError> {
            self.publishes.set(self.publishes.get() + 1);
            if self.fail_publish {
                return Err(PublisherError::new("PATCH failed"));
            }
            let mut release = self
                .release
                .borrow()
                .clone()
                .ok_or_else(|| PublisherError::new("release missing"))?;
            release.draft = false;
            self.release.replace(Some(release.clone()));
            if self.lose_publish {
                Err(PublisherError::new("lost PATCH response"))
            } else {
                Ok(release)
            }
        }

        fn verify_asset(&self, request: VerifyAssetRequest<'_>) -> Result<(), PublisherError> {
            self.verifications.set(self.verifications.get() + 1);
            if self.corrupt_verify {
                return Err(PublisherError::new("remote bytes mismatch"));
            }
            let assets = self.assets.borrow();
            let (_, bytes) = assets
                .iter()
                .find(|(asset, _)| asset.id == request.asset.id)
                .ok_or_else(|| PublisherError::new("asset missing"))?;
            if bytes.len() as u64 != request.size
                || crate::hex(&Sha256::digest(bytes)) != request.sha256
                || request.asset.browser_download_url != request.expected_url
            {
                return Err(PublisherError::new("remote bytes mismatch"));
            }
            std::fs::write(request.output, bytes)
                .map_err(|error| PublisherError::io("write verification fixture", error))
        }
    }

    pub(crate) fn staged() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let submission = root.path().join("submission.json");
        let digest = crate::hex(&Sha256::digest(ARCHIVE));
        let value = json!({
            "schema_version": 1,
            "package": {
                "agent": {"id":"acme","name":"Acme","version":"1.0.0","description":"Agent","license":"MIT","repository":"https://github.com/acme/provider","distribution":{"binary":{"linux-x86_64":{"archive":"https://github.com/acme/provider/releases/download/v1/provider.tgz","cmd":"bin/provider","sha256":digest}}}},
                "host": {"publisher":"acme","compatibility":{"min_app_version":"0.12.0"},"assets":{"icon":"icon.svg","readme":"README.md","license":"LICENSE"}}
            },
            "source":{"repository":"https://github.com/acme/provider","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tag":"v1"},
            "changelog":"Release"
        });
        std::fs::write(&submission, serde_json::to_vec(&value).unwrap()).unwrap();
        stage::stage(
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            &FixtureDownloader,
        )
        .unwrap();
        (root, submission)
    }

    pub(crate) fn run(
        root: &tempfile::TempDir,
        submission: &Path,
        client: &FakeClient,
    ) -> Result<MirrorReceipt, PublisherError> {
        mirror(
            StageRequest::builder()
                .submission(submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            COMMIT,
            client,
        )
    }

    #[test]
    fn lost_responses_reconcile_and_replay_without_create_or_upload() {
        let (root, submission) = staged();
        let client = FakeClient {
            lose_create: true,
            lose_upload: true,
            ..Default::default()
        };
        let first = run(&root, &submission, &client).unwrap();
        assert_eq!(first.status, "draft_verified");
        assert_eq!(client.creates.get(), 1);
        assert_eq!(client.uploads.get(), 2);
        std::fs::write(
            root.path().join(MIRROR_RECEIPT),
            format!("{}\n", serde_json::to_string_pretty(&first).unwrap()),
        )
        .unwrap();
        let verified_before = client.verifications.get();
        assert_eq!(run(&root, &submission, &client).unwrap(), first);
        assert_eq!(client.verifications.get() - verified_before, 2);
        assert_eq!(client.creates.get(), 1);
        assert_eq!(client.uploads.get(), 2);
    }

    #[test]
    fn missing_staging_and_conflicting_receipt_fail_before_api() {
        let root = tempfile::tempdir().unwrap();
        let submission = root.path().join("missing.json");
        let client = FakeClient::default();
        assert!(run(&root, &submission, &client).is_err());
        assert_eq!(client.finds.get(), 0);

        let (root, submission) = staged();
        std::fs::write(root.path().join(MIRROR_RECEIPT), b"{}").unwrap();
        assert!(run(&root, &submission, &client).is_err());
        assert_eq!(client.finds.get(), 0);
    }

    #[test]
    fn wrong_or_drifting_tag_never_writes_a_mirror_receipt() {
        for drift_tag_after in [None, Some(4)] {
            let (root, submission) = staged();
            let client = FakeClient {
                tag_commit: RefCell::new(drift_tag_after.is_none().then(|| "a".repeat(40))),
                drift_tag_after,
                ..Default::default()
            };
            assert!(run(&root, &submission, &client)
                .unwrap_err()
                .to_string()
                .contains("tag commit"));
            if drift_tag_after.is_none() {
                assert_eq!(client.creates.get(), 0);
                assert_eq!(client.uploads.get(), 0);
            } else {
                assert_eq!(client.uploads.get(), 2);
            }
            assert!(!root.path().join(MIRROR_RECEIPT).exists());
        }
    }

    #[test]
    fn promotion_and_corrupt_or_unexpected_assets_fail_closed() {
        let (root, submission) = staged();
        let promoted = FakeClient {
            promote_on_second_find: true,
            ..Default::default()
        };
        assert!(run(&root, &submission, &promoted).is_err());
        assert_eq!(promoted.uploads.get(), 0);

        let (root, submission) = staged();
        let corrupt = FakeClient {
            corrupt_verify: true,
            ..Default::default()
        };
        let foreign = root.path().join(".foreign.part");
        std::fs::write(&foreign, b"keep").unwrap();
        assert!(run(&root, &submission, &corrupt).is_err());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"keep");

        let (root, submission) = staged();
        let unexpected = FakeClient::default();
        run(&root, &submission, &unexpected).unwrap();
        unexpected.assets.borrow_mut().push((
            Asset {
                id: 99,
                name: "foreign".to_owned(),
                state: "uploaded".to_owned(),
                browser_download_url: "secret".to_owned(),
                size: 1,
            },
            vec![0],
        ));
        assert!(run(&root, &submission, &unexpected).is_err());
    }
}
