//! Bounded acquisition and digest verification for managed-provider artifacts.

use std::fmt;
use std::fmt::Write as _;
#[cfg(test)]
use std::io::Read as _;
use std::path::{Path, PathBuf};

use futures::StreamExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;

/// A marketplace artifact may never exceed 256 MiB on the wire.
pub const MAX_ARTIFACT_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

/// Stable reason an artifact could not be safely acquired or extracted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ArtifactErrorCode {
    DownloadFailed,
    DownloadTooLarge,
    HashMismatch,
    UnsupportedArchive,
    UnsafeArchive,
    ArchiveTooLarge,
    TooManyEntries,
    DuplicatePath,
    ExecutableOutsidePackage,
    ExecutableMissing,
    UnsafePermissions,
    Io,
}

/// An acquisition or extraction failure safe to map to a host API error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactError {
    pub code: ArtifactErrorCode,
    pub message: String,
}

impl ArtifactError {
    pub(super) fn new(code: ArtifactErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(context: &str, error: impl fmt::Display) -> Self {
        Self::new(ArtifactErrorCode::Io, format!("{context}: {error}"))
    }

    pub(super) fn outside(message: impl Into<String>) -> Self {
        Self::new(ArtifactErrorCode::ExecutableOutsidePackage, message)
    }

    pub(super) fn unsafe_archive(error: impl fmt::Display) -> Self {
        Self::new(ArtifactErrorCode::UnsafeArchive, error.to_string())
    }

    pub(super) fn archive_io(context: &str, error: impl fmt::Display) -> Self {
        Self::new(ArtifactErrorCode::Io, format!("{context}: {error}"))
    }
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ArtifactError {}

/// Proof that the bytes at `path` matched the signed index digest.
///
/// Fields are private so extraction cannot accidentally accept unverified bytes.
#[derive(Debug, Clone)]
pub struct VerifiedArtifact {
    path: PathBuf,
    source_name: String,
    sha256: String,
    size: u64,
}

impl VerifiedArtifact {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn source_name(&self) -> &str {
        &self.source_name
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn size(&self) -> u64 {
        self.size
    }
}

/// Download an HTTPS artifact into a newly-created staging file and verify it.
pub async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    expected_sha256: &str,
    destination: &Path,
) -> Result<VerifiedArtifact, ArtifactError> {
    validate_https_url(url)?;
    let response = client.get(url).send().await.map_err(|error| {
        ArtifactError::new(
            ArtifactErrorCode::DownloadFailed,
            format!("managed-provider artifact request failed: {error}"),
        )
    })?;
    if response.url().scheme() != "https" {
        return Err(ArtifactError::new(
            ArtifactErrorCode::DownloadFailed,
            "managed-provider artifact redirect downgraded from HTTPS",
        ));
    }
    if !response.status().is_success() {
        return Err(ArtifactError::new(
            ArtifactErrorCode::DownloadFailed,
            format!(
                "managed-provider artifact request returned HTTP {}",
                response.status()
            ),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ARTIFACT_DOWNLOAD_BYTES)
    {
        return Err(too_large(response.content_length().unwrap_or_default()));
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(|error| ArtifactError::io("create artifact staging file", error))?;
    let result = stream_response(response, &mut file, expected_sha256).await;
    match result {
        Ok((sha256, size)) => {
            if let Err(error) = file.sync_all().await {
                drop(file);
                return Err(cleanup_partial(
                    destination,
                    ArtifactError::io("sync artifact staging file", error),
                )
                .await);
            }
            Ok(VerifiedArtifact {
                path: destination.to_path_buf(),
                source_name: url.to_string(),
                sha256,
                size,
            })
        }
        Err(error) => {
            drop(file);
            Err(cleanup_partial(destination, error).await)
        }
    }
}

async fn stream_response(
    response: reqwest::Response,
    file: &mut tokio::fs::File,
    expected_sha256: &str,
) -> Result<(String, u64), ArtifactError> {
    let expected = normalize_digest(expected_sha256)?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            ArtifactError::new(
                ArtifactErrorCode::DownloadFailed,
                format!("managed-provider artifact stream failed: {error}"),
            )
        })?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| too_large(u64::MAX))?;
        if size > MAX_ARTIFACT_DOWNLOAD_BYTES {
            return Err(too_large(size));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| ArtifactError::io("write artifact staging file", error))?;
    }
    let actual = digest_hex(hasher.finalize().as_ref());
    verify_digest(&expected, &actual)?;
    Ok((actual, size))
}

/// Verify a bounded local artifact before handing it to the extractor.
#[cfg(test)]
pub fn verify_local_artifact(
    path: &Path,
    source_name: &str,
    expected_sha256: &str,
) -> Result<VerifiedArtifact, ArtifactError> {
    let expected = normalize_digest(expected_sha256)?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| ArtifactError::io("inspect artifact", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ArtifactError::new(
            ArtifactErrorCode::Io,
            format!("artifact {} is not a regular file", path.display()),
        ));
    }
    if metadata.len() > MAX_ARTIFACT_DOWNLOAD_BYTES {
        return Err(too_large(metadata.len()));
    }
    let file =
        std::fs::File::open(path).map_err(|error| ArtifactError::io("open artifact", error))?;
    let mut hasher = Sha256::new();
    let mut reader = file.take(MAX_ARTIFACT_DOWNLOAD_BYTES + 1);
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| ArtifactError::io("hash artifact", error))?;
        if count == 0 {
            break;
        }
        size += count as u64;
        hasher.update(&buffer[..count]);
    }
    if size > MAX_ARTIFACT_DOWNLOAD_BYTES {
        return Err(too_large(size));
    }
    let actual = digest_hex(hasher.finalize().as_ref());
    verify_digest(&expected, &actual)?;
    Ok(VerifiedArtifact {
        path: path.to_path_buf(),
        source_name: source_name.to_string(),
        sha256: actual,
        size,
    })
}

fn validate_https_url(url: &str) -> Result<(), ArtifactError> {
    let parsed = reqwest::Url::parse(url).map_err(|error| {
        ArtifactError::new(
            ArtifactErrorCode::DownloadFailed,
            format!("invalid managed-provider artifact URL: {error}"),
        )
    })?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(ArtifactError::new(
            ArtifactErrorCode::DownloadFailed,
            "managed-provider artifact URL must use HTTPS and include a host",
        ));
    }
    Ok(())
}

fn normalize_digest(digest: &str) -> Result<String, ArtifactError> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ArtifactError::new(
            ArtifactErrorCode::HashMismatch,
            "expected artifact SHA-256 must be 64 hexadecimal characters",
        ));
    }
    Ok(digest.to_ascii_lowercase())
}

fn verify_digest(expected: &str, actual: &str) -> Result<(), ArtifactError> {
    if expected == actual {
        return Ok(());
    }
    Err(ArtifactError::new(
        ArtifactErrorCode::HashMismatch,
        format!("artifact SHA-256 mismatch: expected {expected}, got {actual}"),
    ))
}

fn digest_hex(digest: &[u8]) -> String {
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn too_large(size: u64) -> ArtifactError {
    ArtifactError::new(
        ArtifactErrorCode::DownloadTooLarge,
        format!(
            "managed-provider artifact is {size} bytes; maximum is {MAX_ARTIFACT_DOWNLOAD_BYTES}"
        ),
    )
}

async fn cleanup_partial(path: &Path, original: ArtifactError) -> ArtifactError {
    match tokio::fs::remove_file(path).await {
        Ok(()) => original,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => original,
        Err(error) => ArtifactError::new(
            original.code,
            format!(
                "{}; additionally failed to remove partial artifact {}: {error}",
                original.message,
                path.display()
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn local_verification_produces_unforgeable_artifact_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent");
        std::fs::write(&path, b"verified bytes").unwrap();
        let digest = "186287b2d987891f027b4bc8baaf621a3e5a4a73ec78e04b0f65dc309b1ccc03";
        let artifact = verify_local_artifact(&path, "agent", digest).unwrap();
        assert_eq!(artifact.path(), path);
        assert_eq!(artifact.source_name(), "agent");
        assert_eq!(artifact.sha256(), digest);
        assert_eq!(artifact.size(), 14);
    }

    #[test]
    fn local_verification_rejects_digest_mismatch_and_oversize_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agent");
        std::fs::write(&path, b"tampered").unwrap();
        let error = verify_local_artifact(&path, "agent", &"0".repeat(64)).unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::HashMismatch);

        let oversized = directory.path().join("oversized");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_ARTIFACT_DOWNLOAD_BYTES + 1).unwrap();
        let error = verify_local_artifact(&oversized, "agent", &"0".repeat(64)).unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::DownloadTooLarge);
    }

    #[test]
    fn invalid_digests_and_non_files_fail_closed() {
        let directory = tempfile::tempdir().unwrap();
        let error = verify_local_artifact(directory.path(), "agent", "abc").unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::HashMismatch);

        let path = directory.path().join("agent");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"x").unwrap();
        let error = verify_local_artifact(&path, "agent", &"z".repeat(64)).unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::HashMismatch);
    }

    #[test]
    fn acquisition_requires_https() {
        for url in [
            "http://example.test/agent",
            "file:///tmp/agent",
            "not a url",
        ] {
            let error = validate_https_url(url).unwrap_err();
            assert_eq!(error.code, ArtifactErrorCode::DownloadFailed);
        }
        validate_https_url("https://example.test/agent").unwrap();
    }
}
