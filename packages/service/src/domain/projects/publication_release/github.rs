use super::remote::{
    GitHubPublishRequest, GitHubPublishedRelease, GitHubReleaseExpectation, GitHubReleaseInspection,
};
use crate::error::AppError;
use cadencr_registry_publisher::author_release;

pub(crate) async fn inspect_publication_release(
    token: &str,
    repository: &str,
    tag: &str,
) -> Result<GitHubReleaseInspection, AppError> {
    author_release::inspect_publication_release(token, repository, tag)
        .await
        .map_err(|error| error.into())
}

pub(crate) async fn publish_publication_release(
    token: &str,
    request: GitHubPublishRequest<'_>,
) -> Result<GitHubPublishedRelease, AppError> {
    author_release::publish_publication_release(token, request)
        .await
        .map_err(|error| error.into())
}

pub(crate) async fn verify_published_publication_release(
    token: &str,
    expectation: GitHubReleaseExpectation,
) -> Result<GitHubPublishedRelease, AppError> {
    author_release::verify_published_publication_release(token, expectation)
        .await
        .map_err(|error| error.into())
}
