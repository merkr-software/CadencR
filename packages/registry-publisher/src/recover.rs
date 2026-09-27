use crate::binding::{build_publication_binding, compact_artifacts, MirrorReceipt, MIRROR_RECEIPT};
use crate::github::ReleaseClient;
use crate::publication_local::{self, RefusingDownloader};
use crate::receipt::publish_canonical_receipt;
use crate::{Downloader, PublisherError, RecoverRequest, StageRequest};

mod local;
mod verify;

#[cfg(test)]
mod fixture;

pub(crate) fn preflight(request: &RecoverRequest<'_>) -> Result<(), PublisherError> {
    local::preflight(
        request.submission,
        request.repository,
        request.registry_commit,
        request.expected_release_tag,
        request.directory,
    )
}

pub(crate) fn recover(
    request: StageRequest<'_>,
    registry_commit: &str,
    expected_release_tag: &str,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<MirrorReceipt, PublisherError> {
    crate::validate_registry_commit(registry_commit)?;
    let lock = publication_local::acquire(request.directory, "recovery")?;
    let result = recover_locked(
        request,
        registry_commit,
        expected_release_tag,
        client,
        downloader,
    );
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

fn recover_locked(
    request: StageRequest<'_>,
    registry_commit: &str,
    expected_release_tag: &str,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<MirrorReceipt, PublisherError> {
    let repository = request.repository;
    let directory = request.directory;
    let staged = crate::stage::stage(request, &RefusingDownloader::for_operation("recovery"))?;
    local::validate_expected_tag(&staged.plan, expected_release_tag)?;
    let binding = build_publication_binding(&staged, repository, registry_commit, directory)?;
    let prior = local::receipts(directory, &binding, repository, registry_commit)?;
    let release_id = verify::verify()
        .binding(&binding)
        .registry_commit(registry_commit)
        .maybe_expected_release_id(prior.release_id)
        .directory(directory)
        .client(client)
        .downloader(downloader)
        .call()?;
    if let Some(receipt) = prior.mirror {
        return Ok(receipt);
    }
    let receipt = MirrorReceipt {
        schema_version: 1,
        status: "published_recovered".to_owned(),
        repository: repository.to_owned(),
        registry_commit: registry_commit.to_owned(),
        release_id,
        release_tag: binding.tag,
        plan_sha256: binding.plan_sha256,
        artifacts: compact_artifacts(&binding.expected),
    };
    publish_canonical_receipt(directory, MIRROR_RECEIPT, &receipt)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::fixture::{node_oracle, published, run, Public, COMMIT, REPOSITORY};
    use super::*;
    use crate::binding::{
        build_publication_binding, build_publication_receipt, PUBLICATION_RECEIPT,
    };
    use crate::publication_local::RefusingDownloader;

    #[test]
    fn recovers_published_release_without_remote_writes_and_replays_raw_receipt() {
        let (root, submission, client, _) = published();
        std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
        let oracle = node_oracle(&root, &submission, &client);
        let oracle_bytes = std::fs::read(root.path().join(MIRROR_RECEIPT)).unwrap();
        std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
        let receipt = run(&root, &submission, &client).unwrap();
        assert_eq!(receipt, oracle);
        assert_eq!(
            std::fs::read(root.path().join(MIRROR_RECEIPT)).unwrap(),
            oracle_bytes
        );
        assert_eq!(receipt.status, "published_recovered");
        assert!(!root.path().join(PUBLICATION_RECEIPT).exists());
        assert_eq!(client.creates.get(), 1);
        assert_eq!(client.uploads.get(), 2);
        assert_eq!(client.publishes.get(), 0);

        let path = root.path().join(MIRROR_RECEIPT);
        let pretty = format!("{}\n", serde_json::to_string_pretty(&receipt).unwrap());
        std::fs::write(&path, &pretty).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(run(&root, &submission, &client).unwrap(), receipt);
        assert_eq!(std::fs::read(path).unwrap(), before);
        assert!(!root.path().join(".mirror.lock").exists());
    }

    #[test]
    fn preserves_valid_draft_receipt_only_after_full_published_verification() {
        let (root, submission, client, mirror) = published();
        let path = root.path().join(MIRROR_RECEIPT);
        let bytes = format!(" {} \n", serde_json::to_string(&mirror).unwrap());
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(run(&root, &submission, &client).unwrap(), mirror);
        assert_eq!(std::fs::read(path).unwrap(), bytes.as_bytes());

        client.release.borrow_mut().as_mut().unwrap().draft = true;
        assert!(run(&root, &submission, &client).is_err());
    }

    #[test]
    fn publication_receipt_without_mirror_binds_remote_id_and_is_not_recreated() {
        let (root, submission, client, mirror) = published();
        std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
        let staged = crate::stage::stage(
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            &RefusingDownloader::for_operation("fixture"),
        )
        .unwrap();
        let binding = build_publication_binding(&staged, REPOSITORY, COMMIT, root.path()).unwrap();
        let publication = build_publication_receipt()
            .binding(&binding)
            .repository(REPOSITORY)
            .registry_commit(COMMIT)
            .release_id(mirror.release_id)
            .call();
        let publication_path = root.path().join(PUBLICATION_RECEIPT);
        let bytes = serde_json::to_vec_pretty(&publication).unwrap();
        std::fs::write(&publication_path, &bytes).unwrap();
        assert_eq!(run(&root, &submission, &client).unwrap().release_id, 7);
        assert_eq!(std::fs::read(publication_path).unwrap(), bytes);
    }

    #[test]
    fn mirror_receipt_rejects_unknown_fields_before_remote_api() {
        let (root, submission, client, mirror) = published();
        let mut value = serde_json::to_value(mirror).unwrap();
        value["unexpected"] = serde_json::json!(true);
        std::fs::write(
            root.path().join(MIRROR_RECEIPT),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let before = client.finds.get();
        assert!(run(&root, &submission, &client).is_err());
        assert_eq!(client.finds.get(), before);
    }

    #[test]
    fn local_failures_and_missing_staging_make_zero_api_calls_and_cleanup_lock() {
        let (root, submission, client, mirror) = published();
        let before = client.finds.get();
        assert!(recover(
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            COMMIT,
            "wrong-tag",
            &client,
            &Public(&client),
        )
        .is_err());
        assert_eq!(client.finds.get(), before);
        assert!(!root.path().join(".mirror.lock").exists());

        std::fs::remove_file(root.path().join(&mirror.artifacts[0].name)).unwrap();
        assert!(run(&root, &submission, &client).is_err());
        assert_eq!(client.finds.get(), before);
    }
}
