use std::path::Path;

use super::*;

pub(super) fn publish_with(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<CatalogPublicationReceipt, PublisherError> {
    let freshness = || snapshot.revalidate_freshness().map_err(Into::into);
    publish_with_freshness(
        snapshot, manifest, directory, client, downloader, &freshness,
    )
}

pub(super) fn publish_with_freshness(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<CatalogPublicationReceipt, PublisherError> {
    preflight(snapshot, manifest, directory)?;
    let lock = crate::fs::OwnedLock::acquire(&directory.join(LOCK))?;
    let result = publish_locked(snapshot, manifest, directory, client, downloader, freshness);
    match result {
        Ok(value) => {
            lock.release(None)?;
            Ok(value)
        }
        Err(error) => Err(lock.release(Some(error)).unwrap_err()),
    }
}

fn publish_locked(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<CatalogPublicationReceipt, PublisherError> {
    let prior = read_receipt(directory, snapshot)?;
    authoritative_prepare(snapshot, manifest, downloader, freshness)?;
    let expected = expected_artifact(snapshot)?;
    verify_tag(client, snapshot, "before publication")?;
    let mut release = resolve_release(client, snapshot, prior.as_ref(), freshness)?;
    let release_id = release.id;
    let mut assets = catalog_assets(client.list_assets(release_id)?, &expected, false)?;
    if !release.draft && assets.is_empty() {
        return Err(PublisherError::new(
            "published catalog release is missing managed-index.json",
        ));
    }
    let recovered = if release.draft && assets.is_empty() {
        validate_current(client, snapshot, release_id, true)?;
        freshness()?;
        let recovered = crate::mirror::artifacts::upload_one(
            client,
            release_id,
            &expected,
            std::slice::from_ref(&expected),
            directory,
        )?;
        assets = catalog_assets(client.list_assets(release_id)?, &expected, true)?;
        recovered
    } else {
        None
    };
    if prior.is_none() {
        if let Some(recovered) = recovered {
            if assets != [recovered] {
                return Err(PublisherError::new(
                    "catalog release asset changed after upload",
                ));
            }
        } else {
            crate::mirror::artifacts::verify_present(
                client,
                &assets,
                std::slice::from_ref(&expected),
                directory,
            )?;
        }
    }
    let verified_asset = assets[0].clone();
    if release.draft {
        validate_current(client, snapshot, release_id, true)?;
        let current_assets = catalog_assets(client.list_assets(release_id)?, &expected, true)?;
        if current_assets != [verified_asset.clone()] {
            return Err(PublisherError::new(
                "catalog release asset changed before publication",
            ));
        }
        verify_tag(client, snapshot, "before publication PATCH")?;
        freshness()?;
        release = match client.publish_draft(release_id) {
            Ok(value) => value,
            Err(primary) => match client.find_release(snapshot.tag())? {
                Some(value)
                    if validate_release(&value, snapshot, Some(release_id), Some(false))
                        .is_ok() =>
                {
                    value
                }
                _ => return Err(primary),
            },
        };
    }
    validate_release(&release, snapshot, Some(release_id), Some(false))?;
    verify_final()
        .client(client)
        .snapshot(snapshot)
        .directory(directory)
        .id(release_id)
        .verified_asset(&verified_asset)
        .expected(&expected)
        .downloader(downloader)
        .freshness(freshness)
        .call()?;
    let receipt = build_receipt(snapshot, release_id);
    if let Some(prior) = prior {
        return Ok(prior);
    }
    crate::receipt::publish_canonical_receipt(directory, RECEIPT, &receipt)?;
    Ok(receipt)
}

fn authoritative_prepare(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    downloader: &impl Downloader,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<(), PublisherError> {
    let payload = crate::catalog::prepare()
        .manifest(manifest)
        .generated_at(snapshot.generated_at())
        .expires_at(snapshot.expires_at())
        .downloader(downloader)
        .expected_repository(snapshot.repository())
        .call()?;
    if payload.canonical_payload() != snapshot.canonical_payload() {
        return Err(PublisherError::new(
            "catalog payload does not exactly match the verified publication manifest",
        ));
    }
    freshness()?;
    Ok(())
}

fn resolve_release(
    client: &impl ReleaseClient,
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    receipt: Option<&CatalogPublicationReceipt>,
    freshness: &impl Fn() -> Result<(), PublisherError>,
) -> Result<Release, PublisherError> {
    let release = match client.find_release(snapshot.tag())? {
        Some(value) => value,
        None if receipt.is_some() => {
            return Err(PublisherError::new(
                "catalog receipt refers to a missing release",
            ))
        }
        None => {
            freshness()?;
            match client.create_draft(
                CreateDraftRequest::builder()
                    .tag(snapshot.tag())
                    .commit(snapshot.registry_commit())
                    .body(snapshot.body())
                    .build(),
            ) {
                Ok(value) => value,
                Err(primary) => client.find_release(snapshot.tag())?.ok_or(primary)?,
            }
        }
    };
    validate_release(
        &release,
        snapshot,
        receipt.map(|value| value.release_id),
        receipt.map(|_| false),
    )?;
    Ok(release)
}

#[cfg(test)]
mod orchestration_tests {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use super::super::fixture::{FlowFixture, PublicMode};
    use super::*;

    #[test]
    fn success_replay_and_lost_responses_mutate_once() {
        for lost in [false, true] {
            let value = FlowFixture::new();
            value.client.set_lost_responses(lost);
            let receipt = publish_with(
                &value.snapshot,
                &value.manifest,
                &value.directory,
                &value.client,
                &value.downloader,
            )
            .unwrap();
            assert_eq!(receipt.release_id, 7);
            assert_eq!(value.client.mutations(), (1, 1, 1));
            assert_eq!(value.client.verifies(), 1);
            assert!(!value.directory.join(LOCK).exists());
            publish_with(
                &value.snapshot,
                &value.manifest,
                &value.directory,
                &value.client,
                &value.downloader,
            )
            .unwrap();
            assert_eq!(value.client.mutations(), (1, 1, 1));
            assert_eq!(value.client.verifies(), 1);
        }
    }

    #[test]
    fn failures_never_write_receipt_and_preserve_owned_cleanup() {
        for mode in [PublicMode::WrongDigest, PublicMode::WrongSize] {
            let value = FlowFixture::new();
            value.downloader.set_public_mode(mode);
            assert!(value.publish().is_err());
            assert!(!value.receipt().exists());
            assert!(value.temporary_entries().is_empty());
        }
        let value = FlowFixture::new();
        value.downloader.set_public_mode(PublicMode::CleanupDrift);
        assert!(value.publish().is_err());
        assert!(!value.receipt().exists());
        assert!(!value.temporary_entries().is_empty());
        let value = FlowFixture::new();
        value.client.fail_patch();
        assert!(value.publish().is_err());
        assert!(value.client.is_draft());
        assert!(!value.receipt().exists());
        let value = FlowFixture::new();
        value.client.wrong_patch_id();
        assert!(value.publish().is_err());
        assert!(!value.receipt().exists());
        let value = FlowFixture::new();
        value.client.set_lost_responses(true);
        value.client.fail_list_at(2);
        assert!(value.publish().is_err());
        assert!(value.temporary_entries().is_empty());
    }

    #[test]
    fn local_conflicts_and_repository_mismatch_do_zero_io() {
        for id in [0, MAX_SAFE_ID + 1] {
            let value = FlowFixture::new();
            value.write_receipt_id(id);
            assert!(value.publish().is_err());
            assert_eq!(value.client.api_calls(), 0);
            assert_eq!(value.downloader.calls(), 0);
        }
        let value = FlowFixture::new();
        std::fs::write(value.receipt(), b"{}").unwrap();
        assert!(value.publish().is_err());
        assert_eq!(value.client.api_calls(), 0);
        assert_eq!(value.downloader.calls(), 0);
        #[cfg(unix)]
        {
            let value = FlowFixture::new();
            symlink("missing", value.receipt()).unwrap();
            assert!(value.publish().is_err());
            assert_eq!(value.client.api_calls(), 0);
            assert_eq!(value.downloader.calls(), 0);
        }
        let value = FlowFixture::new();
        value.set_manifest_repository("other/registry");
        assert!(value.publish().is_err());
        assert_eq!(value.downloader.calls(), 0);
    }

    #[test]
    fn remote_drift_wrong_tags_and_published_missing_asset_fail_closed() {
        for checkpoint in 1..=4 {
            let value = FlowFixture::new();
            value.client.fail_tag_at(checkpoint);
            assert!(value.publish().is_err());
            assert!(!value.receipt().exists());
        }
        for list_call in [3, 4] {
            let value = FlowFixture::new();
            value.client.drift_asset_id_at(list_call);
            assert!(value.publish().is_err());
            assert!(!value.receipt().exists());
        }
        let value = FlowFixture::new();
        value.client.start_published_without_asset();
        assert!(value.publish().is_err());
        assert_eq!(value.client.mutations().1, 0);
        let value = FlowFixture::new();
        value.client.start_prerelease();
        assert!(value.publish().is_err());
        for fault in ["name", "state", "size", "url"] {
            let value = FlowFixture::new();
            value.client.asset_fault(fault);
            assert!(value.publish().is_err());
            assert_eq!(value.client.mutations().2, 0);
        }
    }

    #[test]
    fn freshness_is_checked_at_every_mutation_boundary() {
        for (checkpoint, mutations) in [
            (1, (0, 0, 0)),
            (2, (0, 0, 0)),
            (3, (1, 0, 0)),
            (4, (1, 1, 0)),
            (5, (1, 1, 1)),
        ] {
            let value = FlowFixture::new();
            assert!(value.publish_expiring_at(checkpoint).is_err());
            assert_eq!(value.client.mutations(), mutations);
            assert!(!value.receipt().exists());
        }
    }

    #[test]
    fn resumed_draft_authenticates_existing_asset_before_patch() {
        let value = FlowFixture::new();
        value.client.start_draft_with_asset();
        value.publish().unwrap();
        assert_eq!(value.client.verifies(), 1);
        assert_eq!(value.client.mutations(), (0, 0, 1));

        let value = FlowFixture::new();
        value.client.start_draft_with_asset();
        value.client.fail_verify();
        assert!(value.publish().is_err());
        assert_eq!(value.client.mutations().2, 0);
        assert!(!value.receipt().exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_upload_write_failure_leaves_no_partial() {
        use std::os::unix::fs::PermissionsExt as _;

        let value = FlowFixture::new();
        let calls = std::cell::Cell::new(0);
        let freshness = || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                std::fs::set_permissions(&value.directory, std::fs::Permissions::from_mode(0o500))
                    .unwrap();
            }
            Ok(())
        };
        assert!(publish_with_freshness(
            &value.snapshot,
            &value.manifest,
            &value.directory,
            &value.client,
            &value.downloader,
            &freshness,
        )
        .is_err());
        std::fs::set_permissions(&value.directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let lock = value.directory.join(LOCK);
        if lock.exists() {
            std::fs::remove_file(lock).unwrap();
        }
        assert_eq!(value.client.mutations().1, 0);
        assert!(value.temporary_entries().is_empty());
    }
}
