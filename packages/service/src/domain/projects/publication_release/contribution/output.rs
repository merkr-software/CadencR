use std::path::{Path, PathBuf};

use axum::http::StatusCode;

use super::submission::Documents;
use crate::domain::projects::publication_storage;
use crate::error::AppError;

const MAX_EXPORTS: usize = 16;
const MAX_PROJECTS: usize = 256;

pub(super) struct WrittenContribution {
    pub output_directory: String,
    pub package_path: String,
    pub submission_path: String,
    pub pull_request_path: String,
}

pub(super) fn write(
    root: &Path,
    project_id: i64,
    documents: Documents,
) -> Result<WrittenContribution, AppError> {
    validate_filename(&documents.filename)?;
    ensure_root(root)?;
    ensure_capacity(root)?;
    let project = root.join(project_id.to_string());
    ensure_directory(&project)?;
    let output = publication_storage::create_unique_directory(&project)
        .map_err(|error| internal(format!("create contribution output: {error}")))?;
    let result = write_output(&output, &documents).and_then(|paths| {
        sync_dir(&project)?;
        Ok(paths)
    });
    match result {
        Ok(paths) => Ok(response(output, paths)),
        Err(error) => cleanup(&output, &documents.filename, error),
    }
}

struct RelativePaths {
    package: PathBuf,
    submission: PathBuf,
    pull_request: PathBuf,
}

fn write_output(root: &Path, documents: &Documents) -> Result<RelativePaths, AppError> {
    let packages = root.join("packages");
    let submissions = root.join("submissions");
    std::fs::create_dir(&packages)
        .and_then(|()| std::fs::create_dir(&submissions))
        .map_err(|error| internal(format!("create contribution directories: {error}")))?;
    let paths = RelativePaths {
        package: PathBuf::from("packages").join(&documents.filename),
        submission: PathBuf::from("submissions").join(&documents.filename),
        pull_request: PathBuf::from("PULL_REQUEST.md"),
    };
    write_exclusive(&root.join(&paths.package), &documents.package)?;
    write_exclusive(&root.join(&paths.submission), &documents.submission)?;
    write_exclusive(&root.join(&paths.pull_request), &documents.markdown)?;
    sync_dir(&packages)?;
    sync_dir(&submissions)?;
    sync_dir(root)?;
    Ok(paths)
}

fn ensure_root(root: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(root)
        .map_err(|error| internal(format!("create contribution storage: {error}")))?;
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| internal(format!("inspect contribution storage: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(storage("contribution storage root is not a real directory"));
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), AppError> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path).map_err(|error| {
                internal(format!("inspect project contribution storage: {error}"))
            })?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                Err(storage(
                    "project contribution storage is not a real directory",
                ))
            } else {
                Ok(())
            }
        }
        Err(error) => Err(internal(format!(
            "create project contribution storage: {error}"
        ))),
    }
}

fn ensure_capacity(root: &Path) -> Result<(), AppError> {
    let mut exports = 0;
    let mut projects = 0;
    for project in std::fs::read_dir(root)
        .map_err(|error| internal(format!("scan contribution storage: {error}")))?
    {
        let project =
            project.map_err(|error| internal(format!("read contribution entry: {error}")))?;
        require_directory(&project.path())?;
        let name = project.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| storage("project contribution id is not UTF-8"))?;
        let parsed = name
            .parse::<i64>()
            .map_err(|_| storage("project contribution id is invalid"))?;
        if parsed <= 0 || parsed.to_string() != name {
            return Err(storage("project contribution id is invalid"));
        }
        projects += 1;
        if projects > MAX_PROJECTS {
            return Err(storage(
                "contribution storage has too many project directories",
            ));
        }
        for export in std::fs::read_dir(project.path())
            .map_err(|error| internal(format!("scan project contributions: {error}")))?
        {
            let export = export.map_err(|error| internal(format!("read contribution: {error}")))?;
            require_directory(&export.path())?;
            let name = export.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| storage("contribution id is not UTF-8"))?;
            let parsed = uuid::Uuid::parse_str(name)
                .map_err(|_| storage("contribution storage contains an invalid output id"))?;
            if parsed.to_string() != name {
                return Err(storage(
                    "contribution storage contains an invalid output id",
                ));
            }
            exports += 1;
            if exports >= MAX_EXPORTS {
                return Err(storage(
                    "the retained contribution limit of 16 has been reached",
                ));
            }
        }
    }
    Ok(())
}

fn require_directory(path: &Path) -> Result<(), AppError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| internal(format!("inspect contribution entry: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(storage("contribution storage contains an unexpected entry"));
    }
    Ok(())
}

fn validate_filename(name: &str) -> Result<(), AppError> {
    if name.is_empty()
        || name.len() > 255
        || !name.ends_with(".json")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err(storage("contribution filename is unsafe"));
    }
    Ok(())
}

fn write_exclusive(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    publication_storage::write_exclusive_synced(path, bytes)
        .map_err(|error| internal(format!("persist {}: {error}", path.display())))
}

fn sync_dir(path: &Path) -> Result<(), AppError> {
    publication_storage::sync_directory(path)
        .map_err(|error| internal(format!("sync {}: {error}", path.display())))
}

fn response(output: PathBuf, paths: RelativePaths) -> WrittenContribution {
    WrittenContribution {
        output_directory: output.display().to_string(),
        package_path: output.join(paths.package).display().to_string(),
        submission_path: output.join(paths.submission).display().to_string(),
        pull_request_path: output.join(paths.pull_request).display().to_string(),
    }
}

fn cleanup<T>(staging: &Path, filename: &str, error: AppError) -> Result<T, AppError> {
    let mut failures = Vec::new();
    for path in [
        staging.join("packages").join(filename),
        staging.join("submissions").join(filename),
        staging.join("PULL_REQUEST.md"),
    ] {
        if let Err(cleanup) = std::fs::remove_file(&path) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!("{}: {cleanup}", path.display()));
            }
        }
    }
    for path in [
        staging.join("packages"),
        staging.join("submissions"),
        staging.to_path_buf(),
    ] {
        if let Err(cleanup) = std::fs::remove_dir(&path) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!("{}: {cleanup}", path.display()));
            }
        }
    }
    if failures.is_empty() {
        Err(error)
    } else {
        Err(internal(format!(
            "contribution preparation failed ({error}); cleanup also failed: {}",
            failures.join("; ")
        )))
    }
}

fn storage(message: &str) -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        "PUBLICATION_CONTRIBUTION_STORAGE_FULL",
        message,
    )
}

fn internal(message: String) -> AppError {
    AppError::Internal(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn documents(package: &[u8]) -> Documents {
        Documents {
            filename: "acme-1.0.0.json".into(),
            package: package.to_vec(),
            submission: b"submission".to_vec(),
            markdown: b"pull request".to_vec(),
        }
    }

    #[test]
    fn writes_exact_bytes_to_fresh_outputs_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let first = write(root.path(), 7, documents(b"package one")).unwrap();
        let second = write(root.path(), 7, documents(b"package two")).unwrap();
        assert_ne!(first.output_directory, second.output_directory);
        assert_eq!(std::fs::read(&first.package_path).unwrap(), b"package one");
        assert_eq!(std::fs::read(&second.package_path).unwrap(), b"package two");
        assert_eq!(
            std::fs::read(&first.submission_path).unwrap(),
            b"submission"
        );
        assert_eq!(
            std::fs::read(&first.pull_request_path).unwrap(),
            b"pull request"
        );
    }

    #[test]
    fn refuses_the_seventeenth_export_without_deleting_existing_outputs() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("7");
        std::fs::create_dir(&project).unwrap();
        for _ in 0..MAX_EXPORTS {
            std::fs::create_dir(project.join(uuid::Uuid::new_v4().to_string())).unwrap();
        }
        assert!(write(root.path(), 7, documents(b"new")).is_err());
        assert_eq!(std::fs::read_dir(project).unwrap().count(), MAX_EXPORTS);
    }

    #[test]
    fn rejects_unsafe_filename_before_allocating_or_touching_outside_files() {
        let root = tempfile::tempdir().unwrap();
        let sentinel = root.path().join("sentinel.json");
        std::fs::write(&sentinel, "keep").unwrap();
        let mut unsafe_documents = documents(b"new");
        unsafe_documents.filename = "../../sentinel.json".into();
        assert!(write(root.path(), 7, unsafe_documents).is_err());
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "keep");
        assert!(!root.path().join("7").exists());
    }

    #[test]
    fn bounds_empty_project_directories() {
        let root = tempfile::tempdir().unwrap();
        for project in 1..=MAX_PROJECTS + 1 {
            std::fs::create_dir(root.path().join(project.to_string())).unwrap();
        }
        assert!(write(root.path(), 999, documents(b"new")).is_err());
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().count(),
            MAX_PROJECTS + 1
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_storage_entries() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), root.path().join("7")).unwrap();
        assert!(write(root.path(), 7, documents(b"new")).is_err());
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
