use serde_json::Value;

use crate::binding::{build_publication_prebinding, MirrorReceipt, PublicationPrebinding};
use crate::github::ReleaseClient;
use crate::publication_local;
use crate::{Downloader, PublisherError, RestoreRequest};

mod remote;

pub(crate) struct Prepared {
    plan: Value,
    prebinding: PublicationPrebinding,
}

pub(crate) fn preflight(request: &RestoreRequest<'_>) -> Result<Prepared, PublisherError> {
    crate::validate_registry_commit(request.registry_commit)?;
    publication_local::validate_existing_directory(request.directory, "restore")?;
    let plan = cadencr_registry_core::create_publication_plan_from_file(
        request.submission,
        request.repository,
    )?;
    crate::recover::local::validate_expected_tag(&plan, request.expected_release_tag)?;
    let prebinding =
        build_publication_prebinding(&plan, request.repository, request.registry_commit)?;
    crate::receipt::validate_existing_receipt_prebound(request.directory, &prebinding)?;
    crate::recover::local::prebound_receipts(
        request.directory,
        &prebinding,
        request.repository,
        request.registry_commit,
    )?;
    Ok(Prepared { plan, prebinding })
}

pub(crate) fn restore(
    request: RestoreRequest<'_>,
    prepared: Prepared,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<MirrorReceipt, PublisherError> {
    let lock = publication_local::acquire(request.directory, "restore")?;
    let result = restore_locked(request, prepared, client, downloader);
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

fn restore_locked(
    request: RestoreRequest<'_>,
    prepared: Prepared,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<MirrorReceipt, PublisherError> {
    let prior = crate::recover::local::prebound_receipts(
        request.directory,
        &prepared.prebinding,
        request.repository,
        request.registry_commit,
    )?;
    let release_id = remote::inspect(
        &prepared.prebinding,
        request.registry_commit,
        prior.release_id,
        client,
    )?;
    let staged = crate::stage::stage_managed(prepared.plan, request.directory, downloader)?;
    let binding = prepared.prebinding.bind(&staged, request.directory)?;
    let exact = crate::recover::local::receipts(
        request.directory,
        &binding,
        request.repository,
        request.registry_commit,
    )?;
    if exact.release_id.is_some_and(|id| id != release_id) {
        return Err(PublisherError::new(
            "release identity changed during restore",
        ));
    }
    crate::recover::finish_verified()
        .binding(binding)
        .repository(request.repository)
        .registry_commit(request.registry_commit)
        .directory(request.directory)
        .prior(exact)
        .expected_release_id(release_id)
        .client(client)
        .downloader(downloader)
        .call()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::binding::{MIRROR_RECEIPT, PUBLICATION_RECEIPT};
    use crate::recover::fixture::{published, Public, COMMIT, REPOSITORY};

    enum DownloadMode {
        Missing,
        WrongBytes,
        DriftReleaseId,
    }

    struct ManagedDownload<'a> {
        client: &'a crate::mirror::tests::FakeClient,
        mode: DownloadMode,
        calls: Cell<u64>,
    }

    impl Downloader for ManagedDownload<'_> {
        fn download(
            &self,
            request: crate::DownloadRequest<'_>,
        ) -> Result<crate::Downloaded, PublisherError> {
            self.calls.set(self.calls.get() + 1);
            if matches!(self.mode, DownloadMode::Missing) {
                return Err(PublisherError::new("managed destination returned 404"));
            }
            let bytes = self
                .client
                .assets
                .borrow()
                .iter()
                .find(|(asset, _)| asset.browser_download_url == request.url)
                .map(|(_, bytes)| bytes.clone())
                .ok_or_else(|| PublisherError::new("managed destination missing"))?;
            let written = if matches!(self.mode, DownloadMode::WrongBytes) {
                b"wrong".to_vec()
            } else {
                bytes
            };
            std::fs::write(request.output, &written).unwrap();
            if matches!(self.mode, DownloadMode::DriftReleaseId) {
                self.client.release.borrow_mut().as_mut().unwrap().id = 8;
            }
            Ok(crate::Downloaded {
                sha256: crate::hex(&Sha256::digest(&written)),
                size: written.len() as u64,
            })
        }
    }

    fn run(
        request: RestoreRequest<'_>,
        client: &crate::mirror::tests::FakeClient,
    ) -> Result<MirrorReceipt, PublisherError> {
        let prepared = preflight(&request)?;
        restore(request, prepared, client, &Public(client))
    }

    #[test]
    fn restores_missing_managed_bytes_without_remote_writes() {
        let (root, submission, client, expected) = published();
        std::fs::remove_file(root.path().join(&expected.artifacts[0].name)).unwrap();
        let mutations = (
            client.creates.get(),
            client.uploads.get(),
            client.publishes.get(),
        );
        let receipt = run(
            RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(root.path())
                .token("unused")
                .build(),
            &client,
        )
        .unwrap();
        assert_eq!(receipt, expected);
        assert!(root.path().join(&expected.artifacts[0].name).is_file());
        assert_eq!(
            (
                client.creates.get(),
                client.uploads.get(),
                client.publishes.get()
            ),
            mutations
        );
        assert!(!root.path().join(PUBLICATION_RECEIPT).exists());
    }

    #[test]
    fn retains_complete_local_state_and_only_creates_a_missing_mirror_receipt() {
        let (root, submission, client, expected) = published();
        let artifact = root.path().join(&expected.artifacts[0].name);
        let before = std::fs::read(&artifact).unwrap();
        std::fs::remove_file(root.path().join(MIRROR_RECEIPT)).unwrap();
        let receipt = run(
            RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(root.path())
                .token("unused")
                .build(),
            &client,
        )
        .unwrap();
        assert_eq!(std::fs::read(artifact).unwrap(), before);
        assert_eq!(receipt.status, "published_recovered");
        assert!(root.path().join(MIRROR_RECEIPT).is_file());
        assert!(!root.path().join(PUBLICATION_RECEIPT).exists());
    }

    #[test]
    fn remote_mismatch_prevents_staging_and_remote_writes() {
        let (root, submission, client, expected) = published();
        let artifact = root.path().join(&expected.artifacts[0].name);
        std::fs::remove_file(&artifact).unwrap();
        client.release.borrow_mut().as_mut().unwrap().body = "drift".into();
        let mutations = (
            client.creates.get(),
            client.uploads.get(),
            client.publishes.get(),
        );
        let result = run(
            RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(root.path())
                .token("unused")
                .build(),
            &client,
        );
        assert!(result.is_err());
        assert!(!artifact.exists());
        assert_eq!(
            (
                client.creates.get(),
                client.uploads.get(),
                client.publishes.get()
            ),
            mutations
        );
    }

    #[test]
    fn malformed_staging_receipt_fails_during_credential_free_preflight() {
        let (root, submission, client, expected) = published();
        std::fs::write(root.path().join(crate::stage::RECEIPT), b"{").unwrap();
        let finds = client.finds.get();
        let result = preflight(
            &RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(root.path())
                .token("unused")
                .build(),
        );
        assert!(result.is_err());
        assert_eq!(client.finds.get(), finds);
    }

    #[test]
    fn restores_a_true_empty_directory() {
        let (_source, submission, client, expected) = published();
        let empty = tempfile::tempdir().unwrap();
        let receipt = run(
            RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(empty.path())
                .token("unused")
                .build(),
            &client,
        )
        .unwrap();
        assert_eq!(receipt.status, "published_recovered");
        assert!(empty.path().join(&expected.artifacts[0].name).is_file());
        assert!(empty.path().join(MIRROR_RECEIPT).is_file());
        assert!(!empty.path().join(PUBLICATION_RECEIPT).exists());
    }

    #[test]
    fn managed_download_failures_never_fall_back_to_source() {
        for mode in [DownloadMode::Missing, DownloadMode::WrongBytes] {
            let (_source, submission, client, expected) = published();
            let empty = tempfile::tempdir().unwrap();
            let request = RestoreRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .registry_commit(COMMIT)
                .expected_release_tag(&expected.release_tag)
                .directory(empty.path())
                .token("unused")
                .build();
            let prepared = preflight(&request).unwrap();
            let downloader = ManagedDownload {
                client: &client,
                mode,
                calls: Cell::new(0),
            };
            assert!(restore(request, prepared, &client, &downloader).is_err());
            assert_eq!(downloader.calls.get(), 1);
            assert!(!empty.path().join(MIRROR_RECEIPT).exists());
            assert!(!empty.path().join(&expected.artifacts[0].name).exists());
        }
    }

    #[test]
    fn release_identity_drift_during_download_creates_no_mirror_proof() {
        let (_source, submission, client, expected) = published();
        let empty = tempfile::tempdir().unwrap();
        let request = RestoreRequest::builder()
            .submission(&submission)
            .repository(REPOSITORY)
            .registry_commit(COMMIT)
            .expected_release_tag(&expected.release_tag)
            .directory(empty.path())
            .token("unused")
            .build();
        let prepared = preflight(&request).unwrap();
        let downloader = ManagedDownload {
            client: &client,
            mode: DownloadMode::DriftReleaseId,
            calls: Cell::new(0),
        };
        assert!(restore(request, prepared, &client, &downloader).is_err());
        assert_eq!(downloader.calls.get(), 1);
        assert!(!empty.path().join(MIRROR_RECEIPT).exists());
        assert!(!empty.path().join(PUBLICATION_RECEIPT).exists());
    }

    #[test]
    fn real_github_client_restore_is_get_only() {
        let (_source, submission, source, expected) = published();
        let release = source.release.borrow().clone().unwrap();
        let assets = source.assets.borrow().clone();
        let (base, observed, server) =
            crate::recover::verify::fixture::serve_restore(release, assets);
        let client =
            crate::github::GitHubClient::fixture(REPOSITORY, "secret-token", base.clone(), base)
                .unwrap();
        let empty = tempfile::tempdir().unwrap();
        let request = RestoreRequest::builder()
            .submission(&submission)
            .repository(REPOSITORY)
            .registry_commit(COMMIT)
            .expected_release_tag(&expected.release_tag)
            .directory(empty.path())
            .token("unused")
            .build();
        let prepared = preflight(&request).unwrap();
        restore(request, prepared, &client, &Public(&source)).unwrap();
        server.join().unwrap();
        let observed = observed.lock().unwrap();
        assert_eq!(observed.paths.len(), 13);
        assert_eq!(observed.authenticated, 13);
        assert!(observed.paths.iter().all(|path| path.starts_with('/')));
    }
}
