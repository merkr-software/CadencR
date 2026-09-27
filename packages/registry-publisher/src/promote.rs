mod local;
pub(crate) mod public;

use crate::binding::{
    build_publication_binding, build_publication_receipt, read_mirror_receipt,
    read_publication_receipt, PublicationReceipt, PUBLICATION_RECEIPT,
};
use crate::github::ReleaseClient;
use crate::mirror::artifacts::{validated_assets, verify_present};
use crate::mirror::release::validate_published_release;
use crate::publication_local::{self, RefusingDownloader};
use crate::receipt::publish_canonical_receipt;
use crate::stage;
use crate::{Downloader, PublisherError, StageRequest};

#[derive(bon::Builder)]
pub(crate) struct PromotionExpectation<'a> {
    pub(crate) registry_commit: &'a str,
    pub(crate) release_tag: &'a str,
}

pub(crate) fn promote(
    request: StageRequest<'_>,
    expectation: PromotionExpectation<'_>,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<PublicationReceipt, PublisherError> {
    crate::validate_registry_commit(expectation.registry_commit)?;
    let lock = publication_local::acquire(request.directory, "promotion")?;
    let result = promote_locked(request, expectation, client, downloader);
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

fn promote_locked(
    request: StageRequest<'_>,
    expectation: PromotionExpectation<'_>,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<PublicationReceipt, PublisherError> {
    let registry_commit = expectation.registry_commit;
    let repository = request.repository;
    let directory = request.directory;
    let staged = stage::stage(request, &RefusingDownloader::for_operation("promotion"))?;
    let binding = build_publication_binding(&staged, repository, registry_commit, directory)?;
    if binding.tag != expectation.release_tag {
        return Err(PublisherError::new(
            "publication release tag changed after confirmation",
        ));
    }
    let mirror = read_mirror_receipt(directory, &binding, repository, registry_commit)?
        .ok_or_else(|| PublisherError::new("mirror receipt is required before publication"))?;
    let prior = read_publication_receipt()
        .directory(directory)
        .binding(&binding)
        .repository(repository)
        .registry_commit(registry_commit)
        .release_id(mirror.release_id)
        .call()?;

    let mut release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("mirror receipt refers to a missing release"))?;
    validate_bound_id(&release, &binding, registry_commit, mirror.release_id)?;
    if release.draft && (mirror.status == "published_recovered" || prior.is_some()) {
        return Err(PublisherError::new(
            "historically published release is unexpectedly draft",
        ));
    }
    let assets = validated_assets(client.list_assets(release.id)?, &binding.expected, true)?;
    verify_exact_tag(client, &binding.tag, registry_commit, "before publication")?;

    if release.draft {
        verify_present(client, &assets, &binding.expected, directory)?;
        release = publish_bound_draft(client, &binding, registry_commit, release.id, &assets)?;
    }
    validate_published_release(
        &release,
        &binding.tag,
        registry_commit,
        &binding.body,
        mirror.release_id,
    )?;
    validate_final(client, &binding, registry_commit, mirror.release_id)?;
    verify_exact_tag(client, &binding.tag, registry_commit, "after publication")?;
    public::verify(&binding.expected, directory, downloader)?;
    require_same_assets(
        &assets,
        &validated_assets(client.list_assets(release.id)?, &binding.expected, true)?,
    )?;
    validate_final(client, &binding, registry_commit, mirror.release_id)?;
    verify_exact_tag(
        client,
        &binding.tag,
        registry_commit,
        "after public verification",
    )?;

    let receipt = build_publication_receipt()
        .binding(&binding)
        .repository(repository)
        .registry_commit(registry_commit)
        .release_id(mirror.release_id)
        .call();
    publish_canonical_receipt(directory, PUBLICATION_RECEIPT, &receipt)?;
    Ok(receipt)
}

mod release;
use local::require_same_assets;
pub(crate) use release::verify_exact_tag;
use release::{publish_bound_draft, validate_bound_id, validate_final};

#[cfg(test)]
mod tests {
    use std::path::Path;

    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::mirror::tests::{run as mirror, staged, FakeClient};
    use crate::{DownloadRequest, Downloaded};

    const REPOSITORY: &str = "cadencr/registry";
    const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TAG: &str = "provider-acme-v1.0.0";

    struct Public<'a> {
        client: &'a FakeClient,
        fail: bool,
        drift_tag: bool,
        drift_release: bool,
    }

    impl Downloader for Public<'_> {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            if self.fail {
                return Err(PublisherError::new("public bytes unavailable"));
            }
            let name = request.url.rsplit('/').next().unwrap();
            let bytes = self
                .client
                .assets
                .borrow()
                .iter()
                .find(|(asset, _)| asset.name == name)
                .map(|(_, bytes)| bytes.clone())
                .ok_or_else(|| PublisherError::new("public asset missing"))?;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&request.output)
                .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
                .map_err(|error| PublisherError::io("write public fixture", error))?;
            if self.drift_tag {
                self.client.tag_commit.replace(Some("a".repeat(40)));
            }
            if self.drift_release {
                self.client.release.borrow_mut().as_mut().unwrap().body = "changed".to_owned();
            }
            Ok(Downloaded {
                sha256: crate::hex(&Sha256::digest(&bytes)),
                size: bytes.len() as u64,
            })
        }
    }

    fn setup(client: &FakeClient) -> (tempfile::TempDir, std::path::PathBuf) {
        let (root, submission) = staged();
        client.tag_commit.replace(Some(COMMIT.to_owned()));
        mirror(&root, &submission, client).unwrap();
        (root, submission)
    }

    fn run(
        root: &tempfile::TempDir,
        submission: &Path,
        client: &FakeClient,
        public: &Public<'_>,
    ) -> Result<PublicationReceipt, PublisherError> {
        promote(
            StageRequest::builder()
                .submission(submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            PromotionExpectation::builder()
                .registry_commit(COMMIT)
                .release_tag(TAG)
                .build(),
            client,
            public,
        )
    }

    #[test]
    fn publishes_reconciles_lost_patch_and_replays_without_patch() {
        let client = FakeClient {
            lose_publish: true,
            ..Default::default()
        };
        let (root, submission) = setup(&client);
        let before_verify = client.verifications.get();
        let public = Public {
            client: &client,
            fail: false,
            drift_tag: false,
            drift_release: false,
        };
        let first = run(&root, &submission, &client, &public).unwrap();
        assert_eq!(first.status, "published_verified");
        assert_eq!(client.publishes.get(), 1);
        let after_publish_verify = client.verifications.get();
        assert!(after_publish_verify > before_verify);
        assert_eq!(run(&root, &submission, &client, &public).unwrap(), first);
        assert_eq!(client.publishes.get(), 1);
        assert_eq!(client.verifications.get(), after_publish_verify);
    }

    #[test]
    fn failed_patch_or_public_drift_never_writes_receipt() {
        for mode in ["patch", "public", "tag", "release", "assets"] {
            let client = FakeClient {
                fail_publish: mode == "patch",
                ..Default::default()
            };
            let (root, submission) = setup(&client);
            if mode == "assets" {
                client
                    .drift_assets_after
                    .set(Some(client.asset_lists.get() + 2));
            }
            let public = Public {
                client: &client,
                fail: mode == "public",
                drift_tag: mode == "tag",
                drift_release: mode == "release",
            };
            assert!(run(&root, &submission, &client, &public).is_err());
            assert!(!root.path().join(PUBLICATION_RECEIPT).exists());
            if mode == "patch" {
                assert!(client.release.borrow().as_ref().unwrap().draft);
            }
            if mode == "assets" {
                assert_eq!(client.publishes.get(), 0);
            }
        }
    }

    #[test]
    fn conflicting_receipt_fails_before_api() {
        let client = FakeClient::default();
        let (root, submission) = setup(&client);
        std::fs::write(root.path().join(PUBLICATION_RECEIPT), b"{}").unwrap();
        let before = client.finds.get();
        let public = Public {
            client: &client,
            fail: false,
            drift_tag: false,
            drift_release: false,
        };
        assert!(run(&root, &submission, &client, &public).is_err());
        assert_eq!(client.finds.get(), before);

        for mirror in [None, Some(b"{}".as_slice())] {
            let client = FakeClient::default();
            let (root, submission) = setup(&client);
            let file = root.path().join(crate::binding::MIRROR_RECEIPT);
            std::fs::remove_file(&file).unwrap();
            if let Some(bytes) = mirror {
                std::fs::write(&file, bytes).unwrap();
            }
            let before = client.finds.get();
            let public = Public {
                client: &client,
                fail: false,
                drift_tag: false,
                drift_release: false,
            };
            assert!(run(&root, &submission, &client, &public).is_err());
            assert_eq!(client.finds.get(), before);
        }

        let client = FakeClient::default();
        let (root, submission) = setup(&client);
        let before = client.finds.get();
        let public = Public {
            client: &client,
            fail: false,
            drift_tag: false,
            drift_release: false,
        };
        let result = promote(
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            PromotionExpectation::builder()
                .registry_commit(COMMIT)
                .release_tag("wrong")
                .build(),
            &client,
            &public,
        );
        assert!(result.is_err());
        assert_eq!(client.finds.get(), before);
    }

    #[test]
    fn missing_wrong_tag_and_historical_draft_never_patch() {
        for tag in [None, Some("a".repeat(40))] {
            let client = FakeClient::default();
            let (root, submission) = setup(&client);
            client.tag_commit.replace(tag);
            let public = Public {
                client: &client,
                fail: false,
                drift_tag: false,
                drift_release: false,
            };
            assert!(run(&root, &submission, &client, &public).is_err());
            assert_eq!(client.publishes.get(), 0);
        }
        let client = FakeClient::default();
        let (root, submission) = setup(&client);
        let file = root.path().join(crate::binding::MIRROR_RECEIPT);
        let mut receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        receipt["status"] = "published_recovered".into();
        std::fs::write(&file, serde_json::to_vec(&receipt).unwrap()).unwrap();
        let public = Public {
            client: &client,
            fail: false,
            drift_tag: false,
            drift_release: false,
        };
        assert!(run(&root, &submission, &client, &public).is_err());
        assert_eq!(client.publishes.get(), 0);

        for published in [false, true] {
            let client = FakeClient::default();
            let (root, submission) = setup(&client);
            {
                let mut release = client.release.borrow_mut();
                let release = release.as_mut().unwrap();
                release.prerelease = true;
                release.draft = !published;
            }
            let public = Public {
                client: &client,
                fail: false,
                drift_tag: false,
                drift_release: false,
            };
            assert!(run(&root, &submission, &client, &public).is_err());
            assert_eq!(client.publishes.get(), 0);
        }
    }
}
