use std::path::Path;

use crate::binding::{
    read_mirror_receipt, read_unbound_publication_receipt, validate_publication_receipt,
    MirrorReceipt, PublicationBinding,
};
use crate::{publication_local, PublisherError};

pub(super) struct ExistingReceipts {
    pub(super) mirror: Option<MirrorReceipt>,
    pub(super) release_id: Option<u64>,
}

pub(super) fn preflight(
    submission: &Path,
    repository: &str,
    registry_commit: &str,
    expected_release_tag: &str,
    directory: &Path,
) -> Result<(), PublisherError> {
    crate::validate_registry_commit(registry_commit)?;
    publication_local::validate_existing_directory(directory, "recovery")?;
    let plan = cadencr_registry_core::create_publication_plan_from_file(submission, repository)?;
    validate_expected_tag(&plan, expected_release_tag)
}

pub(super) fn validate_expected_tag(
    plan: &serde_json::Value,
    expected_release_tag: &str,
) -> Result<(), PublisherError> {
    let tag = plan
        .get("release")
        .and_then(|release| release.get("tag"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| PublisherError::new("publication plan binding is invalid"))?;
    if tag != expected_release_tag {
        return Err(PublisherError::new(
            "publication release tag changed after confirmation",
        ));
    }
    Ok(())
}

pub(super) fn receipts(
    directory: &Path,
    binding: &PublicationBinding,
    repository: &str,
    registry_commit: &str,
) -> Result<ExistingReceipts, PublisherError> {
    let mirror = read_mirror_receipt(directory, binding, repository, registry_commit)?;
    let publication = read_unbound_publication_receipt(directory)?;
    if let Some(receipt) = &publication {
        validate_publication_receipt(
            receipt,
            binding,
            repository,
            registry_commit,
            receipt.release_id,
        )?;
    }
    let mirror_id = mirror.as_ref().map(|receipt| receipt.release_id);
    let publication_id = publication.as_ref().map(|receipt| receipt.release_id);
    if mirror_id.is_some() && publication_id.is_some() && mirror_id != publication_id {
        return Err(PublisherError::new(
            "existing publication receipt conflicts with mirror receipt",
        ));
    }
    Ok(ExistingReceipts {
        mirror,
        release_id: mirror_id.or(publication_id),
    })
}

#[cfg(test)]
mod tests {
    use super::super::fixture::{published, run, COMMIT, REPOSITORY};
    use crate::binding::{
        build_publication_binding, build_publication_receipt, MIRROR_RECEIPT, PUBLICATION_RECEIPT,
    };
    use crate::publication_local::RefusingDownloader;
    use crate::StageRequest;

    #[test]
    fn malformed_or_conflicting_publication_receipts_fail_before_api() {
        for mirror_present in [false, true] {
            for mode in [
                "malformed",
                "null",
                "unknown",
                "unsafe-id",
                "conflicting-id",
                "wrong-commit",
                "oversize",
            ] {
                let (root, submission, client, _) = published();
                let staged = crate::stage::stage(
                    StageRequest::builder()
                        .submission(&submission)
                        .repository(REPOSITORY)
                        .directory(root.path())
                        .build(),
                    &RefusingDownloader::for_operation("test"),
                )
                .unwrap();
                let binding =
                    build_publication_binding(&staged, REPOSITORY, COMMIT, root.path()).unwrap();
                let mut value = serde_json::to_value(
                    build_publication_receipt()
                        .binding(&binding)
                        .repository(REPOSITORY)
                        .registry_commit(COMMIT)
                        .release_id(7)
                        .call(),
                )
                .unwrap();
                let bytes = match mode {
                    "malformed" => b"{".to_vec(),
                    "null" => b"null".to_vec(),
                    "oversize" => {
                        vec![b' '; (crate::binding::MAX_PUBLICATION_METADATA_BYTES + 1) as usize]
                    }
                    _ => {
                        match mode {
                            "unknown" => value["unexpected"] = true.into(),
                            "unsafe-id" => value["release_id"] = 9_007_199_254_740_992_u64.into(),
                            "conflicting-id" => value["release_id"] = 8.into(),
                            "wrong-commit" => value["registry_commit"] = "a".repeat(40).into(),
                            _ => unreachable!(),
                        }
                        serde_json::to_vec(&value).unwrap()
                    }
                };
                if !mirror_present {
                    std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
                }
                let path = root.path().join(PUBLICATION_RECEIPT);
                std::fs::write(&path, &bytes).unwrap();
                let before = client.finds.get();
                assert!(run(&root, &submission, &client).is_err(), "{mode}");
                // A structurally valid publication-only ID is compared to GitHub, all others fail locally.
                let expected_reads = u64::from(!mirror_present && mode == "conflicting-id");
                assert_eq!(client.finds.get() - before, expected_reads);
                assert_eq!(std::fs::read(path).unwrap(), bytes);
                assert!(!root.path().join(".mirror.lock").exists());
                if !mirror_present {
                    assert!(!root.path().join(MIRROR_RECEIPT).exists());
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn dangling_receipt_links_fail_before_api_and_remain_untouched() {
        for name in [MIRROR_RECEIPT, PUBLICATION_RECEIPT] {
            let (root, submission, client, _) = published();
            std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
            let path = root.path().join(name);
            std::os::unix::fs::symlink(root.path().join("absent"), &path).unwrap();
            let before = client.finds.get();
            assert!(run(&root, &submission, &client).is_err());
            assert_eq!(client.finds.get(), before);
            assert!(std::fs::symlink_metadata(path)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!root.path().join(".mirror.lock").exists());
        }
    }
}
