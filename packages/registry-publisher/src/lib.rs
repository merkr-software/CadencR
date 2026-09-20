//! Network acquisition and immutable local staging for registry publications.

mod artifact;
mod binding;
mod download;
mod error;
mod fs;
mod github;
mod mirror;
mod receipt;
mod stage;

use std::path::{Path, PathBuf};

pub use binding::{CompactArtifact, MirrorReceipt};
pub use error::PublisherError;
pub use stage::{StageArtifact, StageReceipt};

/// Inputs for one publication staging operation.
#[derive(Debug, bon::Builder)]
pub struct StageRequest<'a> {
    pub submission: &'a Path,
    pub repository: &'a str,
    pub directory: &'a Path,
}

/// Stage and verify every source artifact without overwriting prior output.
pub fn stage_publication(request: StageRequest<'_>) -> Result<StageReceipt, PublisherError> {
    stage::stage(request, &download::ProductionDownloader::default())
}

#[derive(Debug, Clone)]
struct DownloadRequest<'a> {
    url: &'a str,
    sha256: &'a str,
    output: PathBuf,
    max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Downloaded {
    sha256: String,
    size: u64,
}

trait Downloader {
    fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError>;
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut output, "{byte:02x}").expect("writing to a string cannot fail");
    }
    output
}

/// Inputs for a confirmed draft mirror operation. Credentials are never logged.
#[derive(bon::Builder)]
pub struct MirrorRequest<'a> {
    pub submission: &'a Path,
    pub repository: &'a str,
    pub registry_commit: &'a str,
    pub directory: &'a Path,
    pub token: &'a str,
}

/// Mirror already staged artifacts into a bound GitHub draft, never publish it.
pub fn mirror_publication(request: MirrorRequest<'_>) -> Result<MirrorReceipt, PublisherError> {
    let client = github::GitHubClient::new(request.repository, request.token)?;
    mirror::mirror(
        StageRequest::builder()
            .submission(request.submission)
            .repository(request.repository)
            .directory(request.directory)
            .build(),
        request.registry_commit,
        &client,
    )
}

/// Validate an exact registry revision without accessing credentials or the network.
pub fn validate_registry_commit(commit: &str) -> Result<(), PublisherError> {
    if commit.len() != 40
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(PublisherError::new(
            "registry commit must be 40 lowercase hex characters",
        ));
    }
    Ok(())
}
