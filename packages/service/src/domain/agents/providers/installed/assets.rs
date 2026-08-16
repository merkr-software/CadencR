//! Connector-owned visual assets, safely inlined for renderer use.
//!
//! A descriptor's `agent.icon` is portable metadata, while the host-owned
//! `installation.assets.directory` tells this installation where the local
//! package was extracted. The renderer may be remote and cannot authenticate an
//! `<img>` request to a filesystem route, so the bounded bytes travel as a data
//! URL in the provider catalog.

use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use super::descriptor::LocalAssetsSpec;
use crate::shared::image_file::image_or_svg_mime_for_path;

const MAX_ICON_BYTES: u64 = 128 * 1024;

#[derive(Debug, Clone, Default)]
pub enum ProviderIconAsset {
    #[default]
    Absent,
    Loaded(String),
    Invalid(String),
}

impl ProviderIconAsset {
    pub fn load(icon: Option<&str>, assets: Option<&LocalAssetsSpec>) -> Self {
        let Some(icon) = icon else {
            return Self::default();
        };
        let Some(assets) = assets else {
            return Self::Invalid(
                "agent.icon is declared but installation.assets.directory is missing".to_string(),
            );
        };
        match read_data_url(Path::new(&assets.directory), Path::new(icon)) {
            Ok(data) => Self::Loaded(data),
            Err(message) => Self::Invalid(message),
        }
    }

    pub fn data(&self) -> Option<&str> {
        match self {
            Self::Loaded(data) => Some(data),
            Self::Absent | Self::Invalid(_) => None,
        }
    }

    pub fn issue_message(&self) -> Option<&str> {
        match self {
            Self::Invalid(message) => Some(message),
            Self::Absent | Self::Loaded(_) => None,
        }
    }
}

fn read_data_url(root: &Path, relative: &Path) -> Result<String, String> {
    let mime = image_or_svg_mime_for_path(relative)
        .ok_or_else(|| "agent.icon is not an image format Cadencr can paint".to_string())?;
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("provider asset directory could not be resolved: {error}"))?;
    let path = std::fs::canonicalize(root.join(relative)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("agent.icon {relative:?} does not exist in the provider package")
        } else {
            format!("agent.icon {relative:?} could not be resolved: {error}")
        }
    })?;
    if !path.starts_with(&root) {
        return Err("agent.icon resolves outside installation.assets.directory".to_string());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("agent.icon could not be inspected: {error}"))?;
    if !metadata.is_file() {
        return Err("agent.icon is not a regular file".to_string());
    }
    if metadata.len() > MAX_ICON_BYTES {
        return Err(format!(
            "agent.icon is {} KiB; provider icons must be at most {} KiB",
            metadata.len() / 1024,
            MAX_ICON_BYTES / 1024,
        ));
    }
    let bytes =
        std::fs::read(&path).map_err(|error| format!("agent.icon could not be read: {error}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::{ProviderIconAsset, MAX_ICON_BYTES};
    use crate::domain::agents::providers::installed::descriptor::LocalAssetsSpec;

    #[test]
    fn inlines_a_package_owned_svg() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("icon.svg"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let assets = LocalAssetsSpec {
            directory: dir.path().display().to_string(),
        };

        let icon = ProviderIconAsset::load(Some("icon.svg"), Some(&assets));

        assert!(icon
            .data()
            .is_some_and(|data| data.starts_with("data:image/svg+xml;base64,")));
        assert!(icon.issue_message().is_none());
    }

    #[test]
    fn refuses_a_symlink_that_escapes_the_package() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), dir.path().join("icon.svg")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.path(), dir.path().join("icon.svg")).unwrap();
        let assets = LocalAssetsSpec {
            directory: dir.path().display().to_string(),
        };

        let icon = ProviderIconAsset::load(Some("icon.svg"), Some(&assets));

        assert!(icon.data().is_none());
        assert!(icon
            .issue_message()
            .is_some_and(|message| message.contains("outside")));
    }

    #[test]
    fn reports_missing_and_oversized_icons_without_loading_them() {
        let dir = tempfile::tempdir().unwrap();
        let assets = LocalAssetsSpec {
            directory: dir.path().display().to_string(),
        };
        let missing = ProviderIconAsset::load(Some("icon.png"), Some(&assets));
        assert!(missing
            .issue_message()
            .is_some_and(|message| message.contains("does not exist")));

        std::fs::write(
            dir.path().join("icon.png"),
            vec![0_u8; (MAX_ICON_BYTES + 1) as usize],
        )
        .unwrap();
        let oversized = ProviderIconAsset::load(Some("icon.png"), Some(&assets));
        assert!(oversized
            .issue_message()
            .is_some_and(|message| message.contains("at most 128 KiB")));
    }
}
