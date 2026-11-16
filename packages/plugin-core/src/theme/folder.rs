use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::{
    parse_distributed_document, validate_distributed_asset, ThemeDocument, ThemeIssue,
    MAX_DISTRIBUTED_ASSET_BYTES, MAX_DISTRIBUTED_DOCUMENT_BYTES,
};

pub struct ValidatedThemeFolder {
    pub directory: PathBuf,
    pub document: ThemeDocument,
    /// Exactly the bounded declarative files a distributable archive may carry.
    pub files: BTreeMap<String, Vec<u8>>,
}

pub fn validate_theme_folder(directory: &Path) -> Result<ValidatedThemeFolder, Vec<ThemeIssue>> {
    let info = std::fs::symlink_metadata(directory)
        .map_err(|error| issue(format!("cannot inspect theme directory: {error}")))?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(issue("theme directory must be a real directory"));
    }
    let directory = directory
        .canonicalize()
        .map_err(|error| issue(error.to_string()))?;
    let bytes = read_regular(
        &directory.join("theme.json"),
        MAX_DISTRIBUTED_DOCUMENT_BYTES,
    )?;
    let document = parse_distributed_document(&bytes)?;
    let mut files = BTreeMap::from([("theme.json".into(), bytes)]);
    if let Some(image) = &document.chrome.texture.image {
        let bytes = read_regular(&directory.join(&image.asset), MAX_DISTRIBUTED_ASSET_BYTES)?;
        validate_distributed_asset(&image.asset, &bytes).map_err(|error| vec![error])?;
        files.insert(image.asset.clone(), bytes);
    }
    Ok(ValidatedThemeFolder {
        directory,
        document,
        files,
    })
}

fn read_regular(path: &Path, limit: usize) -> Result<Vec<u8>, Vec<ThemeIssue>> {
    crate::read_regular_bounded(path, limit as u64)
        .map_err(|error| issue(format!("{}: {error}", path.display())))
}

fn issue(message: impl Into<String>) -> Vec<ThemeIssue> {
    vec![ThemeIssue::document(message)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::test_support::valid_document;

    #[test]
    fn folder_reads_only_declared_inert_content() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("theme.json"),
            serde_json::to_vec(&valid_document()).unwrap(),
        )
        .unwrap();
        std::fs::write(root.path().join("never-package.js"), b"evil").unwrap();
        let folder = validate_theme_folder(root.path()).unwrap();
        assert_eq!(folder.files.len(), 1);
        assert!(folder.files.contains_key("theme.json"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_documents_and_directories() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().join("theme.json");
        std::fs::write(&path, serde_json::to_vec(&valid_document()).unwrap()).unwrap();
        symlink(&path, root.path().join("theme.json")).unwrap();
        assert!(validate_theme_folder(root.path()).is_err());
        let alias = root.path().join("alias");
        symlink(outside.path(), &alias).unwrap();
        assert!(validate_theme_folder(&alias).is_err());
    }
}
