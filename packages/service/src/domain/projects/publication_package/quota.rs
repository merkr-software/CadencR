use std::path::Path;

use axum::http::StatusCode;

use crate::error::AppError;

const MAX_BUNDLES: usize = 16;
const MAX_PROJECT_DIRECTORIES: usize = 256;
const STORAGE_FULL: &str = "PUBLICATION_PACKAGE_STORAGE_FULL";

pub(super) fn ensure_capacity(root: &Path) -> Result<(), AppError> {
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(storage_full(
                root,
                "bundle storage root is not a real directory",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(storage_full(
                root,
                format!("cannot inspect bundle storage root: {error}"),
            ))
        }
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(storage_full(
                root,
                format!("cannot inspect bundle storage: {error}"),
            ))
        }
    };
    let mut projects = 0usize;
    let mut bundles = 0usize;
    for entry in entries {
        let entry = entry.map_err(|error| {
            storage_full(
                root,
                format!("cannot inspect bundle storage entry: {error}"),
            )
        })?;
        projects += 1;
        if projects > MAX_PROJECT_DIRECTORIES {
            return Err(storage_full(
                root,
                "bundle storage has too many project directories",
            ));
        }
        let metadata = std::fs::symlink_metadata(entry.path()).map_err(|error| {
            storage_full(
                root,
                format!("cannot inspect project bundle directory: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(storage_full(
                root,
                format!(
                    "unexpected entry in bundle storage: {}",
                    entry.path().display()
                ),
            ));
        }
        for bundle in std::fs::read_dir(entry.path()).map_err(|error| {
            storage_full(root, format!("cannot inspect project bundles: {error}"))
        })? {
            let bundle = bundle.map_err(|error| {
                storage_full(root, format!("cannot inspect project bundle: {error}"))
            })?;
            let metadata = std::fs::symlink_metadata(bundle.path())
                .map_err(|error| storage_full(root, format!("cannot inspect bundle: {error}")))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(storage_full(
                    root,
                    format!(
                        "unexpected entry in project bundle storage: {}",
                        bundle.path().display()
                    ),
                ));
            }
            bundles += 1;
            if bundles >= MAX_BUNDLES {
                return Err(storage_full(
                    root,
                    format!("the retained bundle limit of {MAX_BUNDLES} has been reached"),
                ));
            }
        }
    }
    Ok(())
}

fn storage_full(root: &Path, detail: impl std::fmt::Display) -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        STORAGE_FULL,
        format!(
            "publication package storage is unavailable: {detail}. No existing bundle was deleted; manually review and remove old bundles under {} before retrying",
            root.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_seventeenth_bundle_without_deleting_existing_outputs() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("7");
        std::fs::create_dir(&project).unwrap();
        for index in 0..MAX_BUNDLES {
            let bundle = project.join(format!("bundle-{index}"));
            std::fs::create_dir(&bundle).unwrap();
            std::fs::write(bundle.join("package.json"), index.to_string()).unwrap();
        }
        let error = ensure_capacity(root.path()).unwrap_err();
        assert!(matches!(
            error,
            AppError::Coded {
                code: STORAGE_FULL,
                ..
            }
        ));
        for index in 0..MAX_BUNDLES {
            assert_eq!(
                std::fs::read_to_string(project.join(format!("bundle-{index}/package.json")))
                    .unwrap(),
                index.to_string()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unexpected_entries_without_removing_them() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("unexpected");
        std::fs::write(&marker, "keep").unwrap();
        assert!(ensure_capacity(root.path()).is_err());
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "keep");

        std::fs::remove_file(&marker).unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), &marker).unwrap();
        assert!(ensure_capacity(root.path()).is_err());
        assert!(std::fs::symlink_metadata(&marker)
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
