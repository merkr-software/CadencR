//! Network acquisition and immutable local staging for registry publications.

mod artifact;
mod binding;
mod catalog;
mod catalog_publish;
mod download;
mod error;
mod fs;
mod github;
mod mirror;
mod promote;
mod publication_local;
mod receipt;
mod stage;

use std::path::{Path, PathBuf};

pub use binding::{CompactArtifact, MirrorReceipt, PublicationReceipt};
pub use catalog_publish::{CatalogPublicationReceipt, PublishCatalogRequest};
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

/// Inputs for a confirmed promotion. Credentials are never logged.
#[derive(bon::Builder)]
pub struct PromoteRequest<'a> {
    pub submission: &'a Path,
    pub repository: &'a str,
    pub registry_commit: &'a str,
    pub expected_release_tag: &'a str,
    pub directory: &'a Path,
    pub token: &'a str,
}

/// Publish a verified bound draft and independently verify its public artifacts.
pub fn promote_publication(
    request: PromoteRequest<'_>,
) -> Result<PublicationReceipt, PublisherError> {
    let client = github::GitHubClient::new(request.repository, request.token)?;
    promote::promote(
        StageRequest::builder()
            .submission(request.submission)
            .repository(request.repository)
            .directory(request.directory)
            .build(),
        promote::PromotionExpectation::builder()
            .registry_commit(request.registry_commit)
            .release_tag(request.expected_release_tag)
            .build(),
        &client,
        &download::ProductionDownloader::default(),
    )
}

/// Local signing inputs; no GitHub token or service profile is consulted.
#[derive(bon::Builder)]
pub struct SignCatalogRequest<'a> {
    pub manifest: &'a Path,
    pub generated_at: &'a str,
    pub expires_at: &'a str,
    pub private_key: &'a Path,
    pub key_id: &'a str,
}

/// Verify published artifacts and return a canonical signed catalog envelope.
pub fn sign_publication_catalog(
    request: SignCatalogRequest<'_>,
) -> Result<Vec<u8>, PublisherError> {
    cadencr_registry_core::validate_signing_key_id(request.key_id)?;
    let payload = catalog::prepare()
        .manifest(request.manifest)
        .generated_at(request.generated_at)
        .expires_at(request.expires_at)
        .downloader(&download::ProductionDownloader::default())
        .call()?;
    cadencr_registry_core::sign_prepared_index(payload, request.private_key, request.key_id)
        .map_err(Into::into)
}

/// Validate all local catalog publication inputs before credentials are read.
pub fn preflight_catalog_publication(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    manifest: &Path,
    directory: &Path,
) -> Result<(), PublisherError> {
    catalog_publish::preflight(snapshot, manifest, directory)
}

/// Publish one already prepared, immutable catalog snapshot.
pub fn publish_catalog(
    request: PublishCatalogRequest<'_>,
) -> Result<CatalogPublicationReceipt, PublisherError> {
    let client = github::GitHubClient::new(request.snapshot.repository(), request.token)?;
    catalog_publish::publish(
        request.snapshot,
        request.manifest,
        request.directory,
        &client,
    )
}
