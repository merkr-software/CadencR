use std::path::Path;

use crate::binding::ExpectedArtifact;
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, Downloader, PublisherError};

pub(crate) fn verify(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_with_policy(expected, directory, downloader, None)
}

pub(crate) fn verify_theme_package(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_with_policy(expected, directory, downloader, Some("theme"))
}

pub(crate) fn verify_plugin_package(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_with_policy(expected, directory, downloader, Some("plugin"))
}

pub(crate) fn verify_tab_package(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_with_policy(expected, directory, downloader, Some("tab"))
}

fn verify_with_policy(
    expected: &[ExpectedArtifact],
    directory: &Path,
    downloader: &impl Downloader,
    kind: Option<&str>,
) -> Result<(), PublisherError> {
    for artifact in expected {
        let temporary = OwnedDirectory::create(directory, ".promote-public-")?;
        let output = temporary.path().join("asset");
        let result = downloader.download(DownloadRequest {
            url: &artifact.expected_url,
            sha256: &artifact.sha256,
            output: output.clone(),
            max_bytes: artifact.size,
        });
        let result = result.and_then(|downloaded| {
            if downloaded.size != artifact.size || downloaded.sha256 != artifact.sha256 {
                return Err(PublisherError::new("public asset size does not match"));
            }
            match web_archive_kind(kind, &artifact.name) {
                Some("theme") => cadencr_registry_core::verify_theme_archive(&output)?,
                Some("tab") => cadencr_registry_core::verify_tab_archive(&output)?,
                _ => {}
            }
            Ok(())
        });
        combine_cleanup(result, temporary.remove())?;
    }
    Ok(())
}

/// The kind of the web archive an asset holds: `theme.tar.gz` or
/// `tab.tar.gz` for a standalone package, a plugin member's web archive (see
/// [`cadencr_registry_core::plugin_web_archive_kind`]) for a plugin.
fn web_archive_kind(kind: Option<&str>, name: &str) -> Option<&'static str> {
    match kind {
        Some("plugin") => cadencr_registry_core::plugin_web_archive_kind(name),
        _ => ["theme", "tab"]
            .into_iter()
            .find(|web| kind == Some(*web) && name == format!("{web}.tar.gz")),
    }
}

#[cfg(test)]
mod tests {
    use super::web_archive_kind;

    #[test]
    fn web_archives_are_recognized_per_package_kind() {
        assert_eq!(
            web_archive_kind(Some("theme"), "theme.tar.gz"),
            Some("theme")
        );
        assert_eq!(web_archive_kind(Some("tab"), "tab.tar.gz"), Some("tab"));
        assert_eq!(web_archive_kind(Some("tab"), "theme.tar.gz"), None);
        assert_eq!(web_archive_kind(None, "theme.tar.gz"), None);
        let plugin = Some("plugin");
        assert_eq!(
            web_archive_kind(plugin, "theme-aurora-theme-theme.tar.gz"),
            Some("theme")
        );
        assert_eq!(
            web_archive_kind(plugin, "tab-aurora-tab-tab.tar.gz"),
            Some("tab")
        );
        assert_eq!(
            web_archive_kind(plugin, "tab-aurora-tab-backend-linux-x86_64-ab.tar.gz"),
            None
        );
        assert_eq!(
            web_archive_kind(plugin, "provider-agent-darwin-aarch64-ab.tar.gz"),
            None
        );
        assert_eq!(web_archive_kind(plugin, "theme--theme.tar.gz"), None);
    }
}
