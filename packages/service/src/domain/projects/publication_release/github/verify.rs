use super::listing::find_release;
use super::state::{conflict, exact_published, validate_release, validate_request};
use super::transport::Transport;
use super::{binding_body, GitHubPublishedRelease, GitHubReleaseExpectation};
use crate::error::AppError;

pub(super) async fn published(
    transport: &Transport,
    token: &str,
    expectation: &GitHubReleaseExpectation,
) -> Result<GitHubPublishedRelease, AppError> {
    validate_request(expectation)?;
    let body = binding_body(&expectation.release_notes, &expectation.binding_sha256);
    let release = find_release(transport, token, &expectation.repository, &expectation.tag)
        .await?
        .ok_or_else(|| conflict("GitHub published release is missing"))?;
    validate_release(&release, expectation, &body)?;
    if release.draft {
        return Err(conflict("GitHub release is still a draft"));
    }
    exact_published(transport, token, expectation, &release, true).await
}
