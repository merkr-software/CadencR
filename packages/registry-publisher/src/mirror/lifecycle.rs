use super::*;

pub(super) fn mirror_locked(
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

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use crate::binding::MIRROR_RECEIPT;
    use crate::github::Asset;
    use std::cell::RefCell;

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
