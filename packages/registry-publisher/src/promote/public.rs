use std::path::Path;

use crate::binding::ExpectedArtifact;
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, Downloader, PublisherError};

pub(crate) fn verify(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    for artifact in expected {
        let temporary = OwnedDirectory::create(directory, ".promote-public-")?;
        let output = temporary.path().join("asset");
        let result = downloader.download(DownloadRequest {
            url: &artifact.expected_url,
            sha256: &artifact.sha256,
            output,
            max_bytes: artifact.size,
        });
        let result = result.and_then(|downloaded| {
            if downloaded.size != artifact.size || downloaded.sha256 != artifact.sha256 {
                return Err(PublisherError::new("public asset size does not match"));
            }
            Ok(())
        });
        combine_cleanup(result, temporary.remove())?;
    }
    Ok(())
}
