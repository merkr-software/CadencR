use std::path::Path;

use crate::binding::PublicationBinding;
use crate::github::ReleaseClient;
use crate::mirror::artifacts::{validated_assets, verify_present};
use crate::mirror::release::validate_published_release;
use crate::promote::{public, verify_exact_tag};
use crate::{Downloader, PublisherError};

const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

#[cfg(test)]
pub(crate) mod fixture;

/// Reconstructs the remote proof for a publication without mutating GitHub or
/// local receipt state. The caller owns locking and local binding validation.
#[bon::builder]
pub(crate) fn verify(
    binding: &PublicationBinding,
    registry_commit: &str,
    expected_release_id: Option<u64>,
    directory: &Path,
    client: &impl ReleaseClient,
    downloader: &impl Downloader,
) -> Result<u64, PublisherError> {
    crate::validate_registry_commit(registry_commit)?;
    if expected_release_id.is_some_and(|id| !(1..=MAX_SAFE_ID).contains(&id)) {
        return Err(PublisherError::new("release id is invalid"));
    }

    let release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("published release is required but missing"))?;
    if !(1..=MAX_SAFE_ID).contains(&release.id) {
        return Err(PublisherError::new("release id is invalid"));
    }
    let release_id = expected_release_id.unwrap_or(release.id);
    validate_published_release(
        &release,
        &binding.tag,
        registry_commit,
        &binding.body,
        release_id,
    )?;

    let assets = validated_assets(client.list_assets(release.id)?, &binding.expected, true)?;
    verify_present(client, &assets, &binding.expected, directory)?;
    verify_exact_tag(
        client,
        &binding.tag,
        registry_commit,
        "before recovery verification",
    )?;
    public::verify(&binding.expected, directory, downloader)?;

    let final_assets = validated_assets(client.list_assets(release.id)?, &binding.expected, true)?;
    crate::promote::local::require_same_assets(&assets, &final_assets)?;
    verify_present(client, &final_assets, &binding.expected, directory)?;

    let final_release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("published release disappeared"))?;
    validate_published_release(
        &final_release,
        &binding.tag,
        registry_commit,
        &binding.body,
        release.id,
    )?;
    verify_exact_tag(
        client,
        &binding.tag,
        registry_commit,
        "after recovery verification",
    )?;
    Ok(release.id)
}

#[cfg(test)]
mod tests {
    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::binding::build_publication_binding;
    use crate::github::GitHubClient;
    use crate::mirror::fixture::{run as mirror, staged, FakeClient};
    use crate::publication_local::RefusingDownloader;
    use crate::{DownloadRequest, Downloaded, StageRequest};

    const REPOSITORY: &str = "cadencr/registry";
    const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[derive(Clone, Copy)]
    enum PublicMode {
        Good,
        Failure,
        WrongDigest,
        WrongSize,
        ReleaseDrift,
        TagDrift,
    }

    struct Public<'a> {
        client: &'a FakeClient,
        mode: PublicMode,
    }

    impl Downloader for Public<'_> {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            if matches!(self.mode, PublicMode::Failure) {
                return Err(PublisherError::new("public download failed"));
            }
            let bytes = self
                .client
                .assets
                .borrow()
                .iter()
                .find(|(asset, _)| asset.browser_download_url == request.url)
                .map(|(_, bytes)| bytes.clone())
                .ok_or_else(|| PublisherError::new("public asset missing"))?;
            std::fs::write(request.output, &bytes)
                .map_err(|error| PublisherError::io("write public fixture", error))?;
            if matches!(self.mode, PublicMode::ReleaseDrift) {
                self.client.release.borrow_mut().as_mut().unwrap().body = "drift".into();
            }
            if matches!(self.mode, PublicMode::TagDrift) {
                self.client.tag_commit.replace(Some("a".repeat(40)));
            }
            Ok(Downloaded {
                sha256: if matches!(self.mode, PublicMode::WrongDigest) {
                    "0".repeat(64)
                } else {
                    crate::hex(&Sha256::digest(&bytes))
                },
                size: bytes.len() as u64 + u64::from(matches!(self.mode, PublicMode::WrongSize)),
            })
        }
    }

    fn setup() -> (tempfile::TempDir, PublicationBinding, FakeClient) {
        let (root, submission) = staged();
        let client = FakeClient::default();
        let receipt = mirror(&root, &submission, &client).unwrap();
        client.release.borrow_mut().as_mut().unwrap().draft = false;
        client.tag_commit.replace(Some(COMMIT.to_owned()));
        let staged = crate::stage::stage(
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build(),
            &RefusingDownloader::for_operation("recovery test"),
        )
        .unwrap();
        let binding = build_publication_binding(&staged, REPOSITORY, COMMIT, root.path()).unwrap();
        assert_eq!(receipt.release_id, 7);
        (root, binding, client)
    }

    fn run(
        root: &tempfile::TempDir,
        binding: &PublicationBinding,
        client: &FakeClient,
    ) -> Result<u64, PublisherError> {
        verify()
            .binding(binding)
            .registry_commit(COMMIT)
            .expected_release_id(7)
            .directory(root.path())
            .client(client)
            .downloader(&Public {
                client,
                mode: PublicMode::Good,
            })
            .call()
    }

    fn run_with(
        root: &tempfile::TempDir,
        binding: &PublicationBinding,
        client: &FakeClient,
        expected_release_id: Option<u64>,
        mode: PublicMode,
    ) -> Result<u64, PublisherError> {
        verify()
            .binding(binding)
            .registry_commit(COMMIT)
            .maybe_expected_release_id(expected_release_id)
            .directory(root.path())
            .client(client)
            .downloader(&Public { client, mode })
            .call()
    }

    #[test]
    fn reconstructs_remote_proof_without_mutations() {
        let (root, binding, client) = setup();
        let mutations = (
            client.creates.get(),
            client.uploads.get(),
            client.publishes.get(),
        );
        let verifications = client.verifications.get();
        let asset_lists = client.asset_lists.get();
        assert_eq!(run(&root, &binding, &client).unwrap(), 7);
        assert_eq!(
            (
                client.creates.get(),
                client.uploads.get(),
                client.publishes.get()
            ),
            mutations
        );
        assert_eq!(client.verifications.get() - verifications, 4);
        assert_eq!(client.asset_lists.get() - asset_lists, 2);
    }

    #[test]
    fn rejects_corrupt_authenticated_bytes_and_wrong_tag() {
        let (root, binding, mut client) = setup();
        client.corrupt_verify = true;
        assert!(run(&root, &binding, &client).is_err());

        let (root, binding, client) = setup();
        client.tag_commit.replace(Some("a".repeat(40)));
        assert!(run(&root, &binding, &client)
            .unwrap_err()
            .to_string()
            .contains("tag commit"));
    }

    #[test]
    fn rejects_missing_or_drifting_assets() {
        let (root, binding, client) = setup();
        client.assets.borrow_mut().pop();
        assert!(run(&root, &binding, &client).is_err());

        let (root, binding, client) = setup();
        client
            .drift_assets_after
            .set(Some(client.asset_lists.get() + 2));
        assert!(run(&root, &binding, &client)
            .unwrap_err()
            .to_string()
            .contains("assets changed"));
    }

    #[test]
    fn rejects_invalid_or_unbound_published_releases() {
        for case in [
            "missing",
            "draft",
            "prerelease",
            "zero-id",
            "unsafe-id",
            "wrong-id",
            "wrong-tag",
            "wrong-commit",
            "wrong-body",
        ] {
            let (root, binding, client) = setup();
            if case == "missing" {
                client.release.replace(None);
            } else {
                let mut release = client.release.borrow_mut();
                let release = release.as_mut().unwrap();
                match case {
                    "draft" => release.draft = true,
                    "prerelease" => release.prerelease = true,
                    "zero-id" => release.id = 0,
                    "unsafe-id" => release.id = MAX_SAFE_ID + 1,
                    "wrong-tag" => release.tag_name = "wrong-tag".into(),
                    "wrong-commit" => release.target_commitish = "a".repeat(40),
                    "wrong-body" => release.body = "wrong body".into(),
                    "wrong-id" => {}
                    _ => unreachable!(),
                }
            }
            let expected = (case != "wrong-id").then_some(7).or(Some(8));
            assert!(
                run_with(&root, &binding, &client, expected, PublicMode::Good).is_err(),
                "case {case} unexpectedly succeeded"
            );
        }
    }

    #[test]
    fn rejects_non_exact_asset_metadata() {
        for case in ["extra", "duplicate", "state", "size", "url"] {
            let (root, binding, client) = setup();
            let mut assets = client.assets.borrow_mut();
            match case {
                "extra" => {
                    let mut extra = assets[0].clone();
                    extra.0.id = 99;
                    extra.0.name = "foreign.bin".into();
                    assets.push(extra);
                }
                "duplicate" => {
                    let mut duplicate = assets[0].clone();
                    duplicate.0.id = 99;
                    assets.push(duplicate);
                }
                "state" => assets[0].0.state = "new".into(),
                "size" => assets[0].0.size += 1,
                "url" => assets[0].0.browser_download_url.push_str("-wrong"),
                _ => unreachable!(),
            }
            drop(assets);
            assert!(
                run_with(&root, &binding, &client, Some(7), PublicMode::Good).is_err(),
                "case {case} unexpectedly succeeded"
            );
        }
    }

    #[test]
    fn public_corruption_failure_and_drift_never_succeed() {
        for mode in [
            PublicMode::Failure,
            PublicMode::WrongDigest,
            PublicMode::WrongSize,
            PublicMode::ReleaseDrift,
            PublicMode::TagDrift,
        ] {
            let (root, binding, client) = setup();
            assert!(run_with(&root, &binding, &client, Some(7), mode).is_err());
        }
    }

    #[test]
    fn real_client_retries_a_lost_get_and_uses_authenticated_gets_only() {
        let (root, binding, source) = setup();
        let publication_receipt = root.path().join(crate::binding::PUBLICATION_RECEIPT);
        assert!(!publication_receipt.exists());
        let release = source.release.borrow().clone().unwrap();
        let assets = source.assets.borrow().clone();
        let (base, observed, server) = super::fixture::serve(release, assets);
        let client = GitHubClient::fixture(REPOSITORY, "secret-token", base.clone(), base).unwrap();
        let call = || {
            verify()
                .binding(&binding)
                .registry_commit(COMMIT)
                .expected_release_id(7)
                .directory(root.path())
                .client(&client)
                .downloader(&Public {
                    client: &source,
                    mode: PublicMode::Good,
                })
                .call()
        };
        assert!(call().is_err(), "the deliberately lost GET must fail");
        assert!(!publication_receipt.exists());
        assert_eq!(call().unwrap(), 7);
        assert!(!publication_receipt.exists());
        server.join().unwrap();
        let observed = observed.lock().unwrap();
        assert_eq!(observed.paths.len(), 11);
        assert_eq!(observed.authenticated, 11);
        assert!(observed.paths.iter().all(|path| path.starts_with('/')));
    }
}
