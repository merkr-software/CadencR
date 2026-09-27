use std::path::Path;

use crate::binding::{
    mirror_receipt_identity_matches, publication_receipt_identity_matches, read_mirror_receipt,
    read_unbound_publication_receipt, validate_publication_receipt, CompactArtifact, MirrorReceipt,
    PublicationBinding, PublicationPrebinding,
};
use crate::stage::MAX_ARCHIVE_BYTES;
use crate::{publication_local, PublisherError};

pub(crate) struct ExistingReceipts {
    pub(crate) mirror: Option<MirrorReceipt>,
    pub(crate) release_id: Option<u64>,
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

pub(crate) fn validate_expected_tag(
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

pub(crate) fn prebound_receipts(
    directory: &Path,
    binding: &PublicationPrebinding,
    repository: &str,
    registry_commit: &str,
) -> Result<ExistingReceipts, PublisherError> {
    let mirror = crate::binding::read_optional::<MirrorReceipt>(
        directory,
        crate::binding::MIRROR_RECEIPT,
        "mirror receipt",
    )?;
    if let Some(receipt) = &mirror {
        validate_prebound_mirror(receipt, binding, repository, registry_commit)?;
    }
    let publication = read_unbound_publication_receipt(directory)?;
    if let Some(receipt) = &publication {
        let valid = publication_receipt_identity_matches(
            receipt,
            repository,
            registry_commit,
            &binding.tag,
            &binding.plan_sha256,
            None,
        ) && validate_prebound_artifacts(&receipt.artifacts, binding).is_ok();
        if !valid {
            return Err(PublisherError::new(
                "existing publication receipt conflicts",
            ));
        }
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

fn validate_prebound_mirror(
    receipt: &MirrorReceipt,
    binding: &PublicationPrebinding,
    repository: &str,
    registry_commit: &str,
) -> Result<(), PublisherError> {
    let valid = mirror_receipt_identity_matches(
        receipt,
        repository,
        registry_commit,
        &binding.tag,
        &binding.plan_sha256,
    ) && validate_prebound_artifacts(&receipt.artifacts, binding).is_ok();
    if !valid {
        return Err(PublisherError::new(
            "existing mirror receipt conflicts with publication",
        ));
    }
    Ok(())
}

fn validate_prebound_artifacts(
    actual: &[CompactArtifact],
    binding: &PublicationPrebinding,
) -> Result<(), PublisherError> {
    if actual.len() != binding.expected.len() {
        return Err(PublisherError::new(
            "publication receipt artifact cardinality conflicts",
        ));
    }
    let mut aggregate = 0_u64;
    for (actual, expected) in actual.iter().zip(&binding.expected) {
        if actual.name != expected.name || actual.sha256 != expected.sha256 {
            return Err(PublisherError::new(
                "publication receipt artifact conflicts",
            ));
        }
        match expected.size {
            Some(size) if actual.size != size => {
                return Err(PublisherError::new("publication provenance size conflicts"));
            }
            Some(_) => {}
            None => {
                if actual.size > MAX_ARCHIVE_BYTES {
                    return Err(PublisherError::new("publication archive size is invalid"));
                }
                aggregate = aggregate
                    .checked_add(actual.size)
                    .ok_or_else(|| PublisherError::new("publication archive sizes overflow"))?;
            }
        }
    }
    if aggregate > crate::stage::MAX_MANAGED_BYTES {
        return Err(PublisherError::new(
            "publication archive aggregate exceeds 1 GiB",
        ));
    }
    Ok(())
}

pub(crate) fn receipts(
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
    use super::*;
    use crate::binding::{
        build_publication_binding, build_publication_receipt, MIRROR_RECEIPT, PUBLICATION_RECEIPT,
    };
    use crate::publication_local::RefusingDownloader;
    use crate::StageRequest;
    use serde_json::json;

    #[test]
    fn prebound_receipts_reject_every_untrusted_identity_and_shape() {
        let plan = json!({
            "release":{"tag":"provider-acme-v1"},
            "targets":[{"asset":"a.tgz","sha256":"11".repeat(32),"destination_url":"https://github.com/cadencr/registry/releases/download/provider-acme-v1/a.tgz"}]
        });
        let binding =
            crate::binding::build_publication_prebinding(&plan, REPOSITORY, COMMIT).unwrap();
        let provenance = binding.expected.last().unwrap();
        let artifacts = json!([
            {"name":"a.tgz","sha256":"11".repeat(32),"size":7},
            {"name":provenance.name,"sha256":provenance.sha256,"size":provenance.size.unwrap()}
        ]);
        for kind in ["mirror", "publication"] {
            for mode in [
                "schema",
                "status",
                "repository",
                "commit",
                "tag-commit",
                "tag",
                "plan",
                "id",
                "cardinality",
                "order",
                "name",
                "digest",
                "archive-size",
                "provenance-size",
                "unknown",
                "malformed",
            ] {
                let root = tempfile::tempdir().unwrap();
                let mut value = if kind == "mirror" {
                    json!({"schema_version":1,"status":"draft_verified","repository":REPOSITORY,"registry_commit":COMMIT,"release_id":7,"release_tag":binding.tag,"plan_sha256":binding.plan_sha256,"artifacts":artifacts})
                } else {
                    json!({"schema_version":1,"status":"published_verified","repository":REPOSITORY,"registry_commit":COMMIT,"release_id":7,"release_tag":binding.tag,"tag_commit":COMMIT,"plan_sha256":binding.plan_sha256,"artifacts":artifacts})
                };
                match mode {
                    "schema" => value["schema_version"] = 2.into(),
                    "status" => value["status"] = "wrong".into(),
                    "repository" => value["repository"] = "other/repo".into(),
                    "commit" => value["registry_commit"] = "a".repeat(40).into(),
                    "tag-commit" => value["tag_commit"] = "a".repeat(40).into(),
                    "tag" => value["release_tag"] = "wrong".into(),
                    "plan" => value["plan_sha256"] = "22".repeat(32).into(),
                    "id" => value["release_id"] = 0.into(),
                    "cardinality" => {
                        value["artifacts"].as_array_mut().unwrap().pop();
                    }
                    "order" => value["artifacts"].as_array_mut().unwrap().swap(0, 1),
                    "name" => value["artifacts"][0]["name"] = "wrong".into(),
                    "digest" => value["artifacts"][0]["sha256"] = "33".repeat(32).into(),
                    "archive-size" => {
                        value["artifacts"][0]["size"] = (MAX_ARCHIVE_BYTES + 1).into()
                    }
                    "provenance-size" => value["artifacts"][1]["size"] = 0.into(),
                    "unknown" => value["unexpected"] = true.into(),
                    "malformed" => {}
                    _ => unreachable!(),
                }
                let name = if kind == "mirror" {
                    MIRROR_RECEIPT
                } else {
                    PUBLICATION_RECEIPT
                };
                let bytes = if mode == "malformed" {
                    b"{".to_vec()
                } else {
                    serde_json::to_vec(&value).unwrap()
                };
                std::fs::write(root.path().join(name), bytes).unwrap();
                assert!(
                    prebound_receipts(root.path(), &binding, REPOSITORY, COMMIT).is_err(),
                    "{kind}/{mode}"
                );
            }
        }
    }

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
