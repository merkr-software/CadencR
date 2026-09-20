use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitHubReleaseInspection {
    pub account: String,
    pub repository_id: u64,
    pub tag_commit: String,
}

#[derive(bon::Builder)]
pub(crate) struct GitHubPublishRequest<'a> {
    pub repository: &'a str,
    pub tag: &'a str,
    pub source_commit: &'a str,
    pub release_notes: &'a str,
    pub prerelease: bool,
    pub archive_name: &'a str,
    pub archive: &'a axum::body::Bytes,
    pub archive_sha256: &'a str,
    pub metadata_name: &'a str,
    pub metadata: &'a axum::body::Bytes,
    pub metadata_sha256: &'a str,
    pub expected_repository_id: u64,
    pub expected_account: &'a str,
    pub binding_sha256: &'a str,
}

pub(crate) struct GitHubReleaseExpectation {
    pub repository: String,
    pub tag: String,
    pub source_commit: String,
    pub release_notes: String,
    pub prerelease: bool,
    pub archive_name: String,
    pub archive_size: u64,
    pub archive_sha256: String,
    pub metadata_name: String,
    pub metadata_size: u64,
    pub metadata_sha256: String,
    pub expected_repository_id: u64,
    pub expected_account: String,
    pub binding_sha256: String,
}

impl GitHubReleaseExpectation {
    pub fn from_request(request: &GitHubPublishRequest<'_>) -> Self {
        Self {
            repository: request.repository.into(),
            tag: request.tag.into(),
            source_commit: request.source_commit.into(),
            release_notes: request.release_notes.into(),
            prerelease: request.prerelease,
            archive_name: request.archive_name.into(),
            archive_size: request.archive.len() as u64,
            archive_sha256: request.archive_sha256.into(),
            metadata_name: request.metadata_name.into(),
            metadata_size: request.metadata.len() as u64,
            metadata_sha256: request.metadata_sha256.into(),
            expected_repository_id: request.expected_repository_id,
            expected_account: request.expected_account.into(),
            binding_sha256: request.binding_sha256.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GitHubPublishedRelease {
    pub release_url: String,
    pub already_published: bool,
}

#[derive(Clone)]
pub(crate) struct GitHubReleaseClient {
    http: reqwest::Client,
}

impl GitHubReleaseClient {
    pub fn new() -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| AppError::Internal(format!("build GitHub release client: {error}")))?;
        Ok(Self { http })
    }

    pub(super) fn http(&self) -> &reqwest::Client {
        &self.http
    }
}
