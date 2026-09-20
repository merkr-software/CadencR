use std::path::{Path as FsPath, PathBuf};

use super::archive::{self, ArchiveBuildRequest};
use super::input::{reject_output_overlap, PreparedInputs};
use super::PreparedPublicationPackage;
use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

pub(super) fn build_package(
    mut input: PreparedInputs,
) -> Result<PreparedPublicationPackage, AppError> {
    super::quota::ensure_capacity(&input.output_root)?;
    std::fs::create_dir_all(&input.output_parent).map_err(|error| {
        AppError::Internal(format!("cannot create publication bundle parent: {error}"))
    })?;
    let canonical_parent = std::fs::canonicalize(&input.output_parent).map_err(|error| {
        AppError::Internal(format!("cannot resolve publication bundle parent: {error}"))
    })?;
    reject_output_overlap(&canonical_parent, &input.staging, &input.project_root)?;
    let output_dir = create_unique_output_dir(&canonical_parent)?;
    let archive_path = output_dir.join("provider.tar.gz");
    let metadata_path = output_dir.join("package.json");
    let result = (|| {
        let request = ArchiveBuildRequest::builder()
            .staging(input.staging.as_path())
            .target(input.target.as_str())
            .package(&input.package)
            .output(archive_path.as_path())
            .build();
        let built = archive::build(request)?;
        let sha = input
            .metadata
            .pointer_mut(&format!(
                "/agent/distribution/binary/{}/sha256",
                escape_json_pointer(&input.target)
            ))
            .ok_or_else(|| AppError::Internal("validated metadata target disappeared".into()))?;
        *sha = serde_json::Value::String(built.sha256.clone());
        let final_package: ManagedProviderPackage = serde_json::from_value(input.metadata.clone())
            .map_err(|error| {
                AppError::Internal(format!("final metadata cannot be decoded: {error}"))
            })?;
        final_package.validate_contract().map_err(|error| {
            AppError::Internal(format!("final publication metadata is invalid: {error}"))
        })?;
        write_metadata_exclusive(&metadata_path, &input.metadata)?;
        Ok(PreparedPublicationPackage {
            project_id: input.project_id,
            plugin_id: input.plugin_id.clone(),
            target: input.target.clone(),
            archive_path: archive_path.display().to_string(),
            metadata_path: metadata_path.display().to_string(),
            sha256: built.sha256,
            size: built.size,
        })
    })();
    match result {
        Ok(response) => Ok(response),
        Err(error) => cleanup_failed_output(&output_dir, &archive_path, &metadata_path, error),
    }
}

fn create_unique_output_dir(parent: &FsPath) -> Result<PathBuf, AppError> {
    for _ in 0..8 {
        let output = parent.join(uuid::Uuid::new_v4().to_string());
        match std::fs::create_dir(&output) {
            Ok(()) => return Ok(output),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "cannot exclusively create publication bundle directory: {error}"
                )))
            }
        }
    }
    Err(AppError::Internal(
        "could not allocate a unique publication bundle directory".into(),
    ))
}

fn escape_json_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn write_metadata_exclusive(path: &FsPath, metadata: &serde_json::Value) -> Result<(), AppError> {
    use std::io::Write as _;
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| AppError::Internal(format!("cannot encode package metadata: {error}")))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(path).map_err(|error| {
        AppError::Internal(format!(
            "cannot exclusively create package metadata: {error}"
        ))
    })?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| AppError::Internal(format!("cannot persist package metadata: {error}")))
}

fn cleanup_failed_output<T>(
    directory: &FsPath,
    archive: &FsPath,
    metadata: &FsPath,
    original: AppError,
) -> Result<T, AppError> {
    let mut failures = Vec::new();
    for path in [archive, metadata] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("{}: {error}", path.display())),
        }
    }
    if let Err(error) = std::fs::remove_dir(directory) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("{}: {error}", directory.display()));
        }
    }
    if failures.is_empty() {
        Err(original)
    } else {
        Err(AppError::Internal(format!(
            "publication package failed ({original}); cleanup failed and incomplete output may remain at {}: {}",
            directory.display(),
            failures.join("; ")
        )))
    }
}
