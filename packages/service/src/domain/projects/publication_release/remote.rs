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
