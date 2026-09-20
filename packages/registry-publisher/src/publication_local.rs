use std::path::Path;

use crate::fs::OwnedLock;
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};

const LOCK: &str = ".mirror.lock";

pub(crate) fn acquire(directory: &Path, operation: &str) -> Result<OwnedLock, PublisherError> {
    let metadata = std::fs::symlink_metadata(directory)
        .map_err(|error| PublisherError::io(&format!("inspect {operation} directory"), error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PublisherError::new(format!(
            "{operation} path must be a non-symlink directory"
        )));
    }
    OwnedLock::acquire(&directory.join(LOCK))
}

pub(crate) struct RefusingDownloader {
    operation: &'static str,
}

impl RefusingDownloader {
    pub(crate) fn for_operation(operation: &'static str) -> Self {
        Self { operation }
    }
}

impl Downloader for RefusingDownloader {
    fn download(&self, _: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        Err(PublisherError::new(format!(
            "publication is not fully staged; {} refuses to download sources",
            self.operation
        )))
    }
}
