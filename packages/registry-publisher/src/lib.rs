//! Network acquisition and immutable local staging for registry publications.

mod artifact;
mod download;
mod error;
mod fs;
mod receipt;
mod stage;

use std::path::{Path, PathBuf};

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
