#[cfg(test)]
mod fixture;
mod inspect;
mod listing;
mod models;
mod state;
mod transport;
mod verify;

use super::remote::{
    GitHubPublishRequest, GitHubPublishedRelease, GitHubReleaseClient, GitHubReleaseExpectation,
    GitHubReleaseInspection,
};
use crate::error::AppError;

use self::models::{GitHubRepository, GitHubUser};
use self::transport::Transport;

const API_VERSION: &str = "2026-03-10";

pub(crate) async fn inspect_publication_release(
    token: &str,
    repository: &str,
    tag: &str,
) -> Result<GitHubReleaseInspection, AppError> {
    let client = GitHubReleaseClient::new()?;
    inspect_with(&Transport::production(client), token, repository, tag).await
}

pub(crate) async fn publish_publication_release(
    token: &str,
    request: GitHubPublishRequest<'_>,
) -> Result<GitHubPublishedRelease, AppError> {
    let client = GitHubReleaseClient::new()?;
    state::publish(&Transport::production(client), token, &request).await
}

pub(crate) async fn verify_published_publication_release(
    token: &str,
    expectation: GitHubReleaseExpectation,
) -> Result<GitHubPublishedRelease, AppError> {
    let client = GitHubReleaseClient::new()?;
    verify::published(&Transport::production(client), token, &expectation).await
}

async fn inspect_with(
    transport: &Transport,
    token: &str,
    repository: &str,
    tag: &str,
) -> Result<GitHubReleaseInspection, AppError> {
    validate_repository(repository)?;
    validate_segment(tag, "release tag")?;
    let user: GitHubUser = transport.get_json(token, "/user").await?;
    let repo: GitHubRepository = transport
        .get_json(token, &format!("/repos/{repository}"))
        .await?;
    if repo.private || !repo.permissions.is_some_and(|permissions| permissions.push) {
        return Err(AppError::BadRequest(
            "GitHub repository must be public and the connected account must have push access"
                .into(),
        ));
    }
    let tag_commit = inspect::resolve_tag_commit(transport, token, repository, tag).await?;
    Ok(GitHubReleaseInspection {
        account: user.login,
        repository_id: repo.id,
        tag_commit,
    })
}

fn validate_repository(value: &str) -> Result<(), AppError> {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    if parts.next().is_some() || owner.is_empty() || repo.is_empty() {
        return Err(AppError::BadRequest(
            "GitHub repository must be owner/repository".into(),
        ));
    }
    validate_segment(owner, "repository owner")?;
    validate_segment(repo, "repository name")
}

fn validate_segment(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > 128
        || value == "."
        || value == ".."
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    {
        return Err(AppError::BadRequest(format!("invalid {label}")));
    }
    Ok(())
}

fn binding_body(notes: &str, binding: &str) -> String {
    format!(
        "{}\n\n<!-- cadencr-publication-binding:sha256:{binding} -->",
        notes.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::fixture::{Fixture, FixtureOptions};
    use super::*;
    use crate::domain::projects::publication_release::remote::GitHubPublishRequest;

    const COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BINDING: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ARCHIVE_SHA: &str = "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3";
    const METADATA_SHA: &str = "45447b7afbd5e544f7d0f1df0fccd26014d9850130abd3f020b89ff96b82079f";

    fn request<'a>(
        archive: &'a axum::body::Bytes,
        metadata: &'a axum::body::Bytes,
    ) -> GitHubPublishRequest<'a> {
        GitHubPublishRequest::builder()
            .repository("acme/provider")
            .tag("v1.0.0")
            .source_commit(COMMIT)
            .release_notes("Release notes")
            .prerelease(false)
            .archive_name("provider.tar.gz")
            .archive(archive)
            .archive_sha256(ARCHIVE_SHA)
            .metadata_name("package.json")
            .metadata(metadata)
            .metadata_sha256(METADATA_SHA)
            .expected_repository_id(42)
            .expected_account("author")
            .binding_sha256(BINDING)
            .build()
    }

    fn expectation(
        archive: &axum::body::Bytes,
        metadata: &axum::body::Bytes,
    ) -> GitHubReleaseExpectation {
        GitHubReleaseExpectation::from_request(&request(archive, metadata))
    }

    #[tokio::test]
    async fn publishes_and_exact_retry_performs_no_writes() {
        let fixture = Fixture::start(FixtureOptions::default()).await;
        let archive = axum::body::Bytes::from_static(b"archive");
        let metadata = axum::body::Bytes::from_static(b"metadata");
        let sizes = expectation(&archive, &metadata);
        assert_eq!(sizes.archive_size, archive.len() as u64);
        assert_eq!(sizes.metadata_size, metadata.len() as u64);
        let first = state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
            .await
            .unwrap();
        assert!(!first.already_published);
        let writes = fixture.writes();
        let second = state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
            .await
            .unwrap();
        assert!(second.already_published);
        assert_eq!(fixture.writes(), writes);
        assert!(fixture.saw_auth_header());
    }

    #[tokio::test]
    async fn reconciles_lost_create_upload_and_publish_responses() {
        let fixture = Fixture::start(FixtureOptions {
            lose_create: true,
            lose_first_upload: true,
            lose_publish: true,
            ..FixtureOptions::default()
        })
        .await;
        let archive = axum::body::Bytes::from_static(b"archive");
        let metadata = axum::body::Bytes::from_static(b"metadata");
        let result = state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
            .await
            .unwrap();
        assert!(!result.already_published);
        assert_eq!(fixture.asset_count(), 2);
    }

    #[tokio::test]
    async fn conflicts_never_overwrite_and_missing_digest_fails_closed() {
        let fixture = Fixture::start(FixtureOptions {
            foreign_body: true,
            ..FixtureOptions::default()
        })
        .await;
        let archive = axum::body::Bytes::from_static(b"archive");
        let metadata = axum::body::Bytes::from_static(b"metadata");
        assert!(
            state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
                .await
                .is_err()
        );
        assert_eq!(fixture.writes(), 0);

        let fixture = Fixture::start(FixtureOptions {
            published: true,
            complete_assets: true,
            omit_digest: true,
            ..FixtureOptions::default()
        })
        .await;
        assert!(
            state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
                .await
                .is_err()
        );
        assert_eq!(fixture.writes(), 0);
    }

    #[tokio::test]
    async fn external_promotion_before_upload_refuses_without_asset_write() {
        let fixture = Fixture::start(FixtureOptions {
            promote_on_second_release_list: true,
            ..FixtureOptions::default()
        })
        .await;
        let archive = axum::body::Bytes::from_static(b"archive");
        let metadata = axum::body::Bytes::from_static(b"metadata");
        assert!(
            state::publish(&fixture.transport, "secret", &request(&archive, &metadata))
                .await
                .is_err()
        );
        assert_eq!(fixture.asset_count(), 0);
    }

    #[tokio::test]
    async fn readonly_verifier_accepts_only_exact_published_state_without_writes() {
        let archive = axum::body::Bytes::from_static(b"archive");
        let metadata = axum::body::Bytes::from_static(b"metadata");
        let good = Fixture::start(FixtureOptions {
            published: true,
            complete_assets: true,
            ..FixtureOptions::default()
        })
        .await;
        let verified =
            verify::published(&good.transport, "secret", &expectation(&archive, &metadata))
                .await
                .unwrap();
        assert!(verified.already_published);
        assert_eq!(good.writes(), 0);

        for options in [
            FixtureOptions {
                complete_assets: true,
                ..FixtureOptions::default()
            },
            FixtureOptions {
                published: true,
                ..FixtureOptions::default()
            },
            FixtureOptions {
                foreign_body: true,
                ..FixtureOptions::default()
            },
            FixtureOptions {
                published: true,
                complete_assets: true,
                omit_digest: true,
                ..FixtureOptions::default()
            },
            FixtureOptions {
                published: true,
                complete_assets: true,
                extra_asset: true,
                ..FixtureOptions::default()
            },
            FixtureOptions {
                published: true,
                complete_assets: true,
                tag_drift: true,
                ..FixtureOptions::default()
            },
        ] {
            let fixture = Fixture::start(options).await;
            assert!(verify::published(
                &fixture.transport,
                "secret",
                &expectation(&archive, &metadata)
            )
            .await
            .is_err());
            assert_eq!(fixture.writes(), 0);
        }
    }
}
