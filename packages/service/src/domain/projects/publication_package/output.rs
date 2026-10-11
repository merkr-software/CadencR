use std::path::{Component, Path as FsPath, PathBuf};

use super::archive::{self, ArchiveBuildRequest};
use super::input::{reject_output_overlap, PreparedInputs};
use super::PreparedPublicationPackage;
use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::domain::projects::publication_storage;
use crate::error::AppError;

pub(super) fn build_package(
    mut input: PreparedInputs,
) -> Result<PreparedPublicationPackage, AppError> {
    super::quota::ensure_capacity(&input.output_root)?;
    let canonical_parent = prepare_output_parent(&input)?;
    let output_dir =
        publication_storage::create_unique_directory(&canonical_parent).map_err(|error| {
            AppError::Internal(format!(
                "cannot exclusively create publication bundle directory: {error}"
            ))
        })?;
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

fn prepare_output_parent(input: &PreparedInputs) -> Result<PathBuf, AppError> {
    let prospective = prospective_path(&input.output_parent)?;
    reject_output_overlap(&prospective, &input.staging, &input.project_root)?;
    require_real_directory_if_present(&input.output_root)?;
    require_real_directory_if_present(&input.output_parent)?;
    std::fs::create_dir_all(&input.output_root)
        .map_err(|error| output_error("create publication bundle root", error))?;
    require_real_directory_if_present(&input.output_root)?;
    match std::fs::create_dir(&input.output_parent) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(output_error("create publication bundle parent", error)),
    }
    require_real_directory_if_present(&input.output_parent)?;
    let root = std::fs::canonicalize(&input.output_root)
        .map_err(|error| output_error("resolve publication bundle root", error))?;
    let parent = std::fs::canonicalize(&input.output_parent)
        .map_err(|error| output_error("resolve publication bundle parent", error))?;
    if parent.parent() != Some(root.as_path()) {
        return Err(AppError::BadRequest(
            "publication bundle parent escapes storage root".into(),
        ));
    }
    reject_output_overlap(&parent, &input.staging, &input.project_root)?;
    Ok(parent)
}

fn prospective_path(path: &FsPath) -> Result<PathBuf, AppError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| output_error("resolve current directory", error))?
            .join(path)
    };
    for ancestor in absolute.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let mut resolved = std::fs::canonicalize(ancestor)
                    .map_err(|error| output_error("resolve publication output ancestor", error))?;
                for component in absolute
                    .strip_prefix(ancestor)
                    .expect("path ancestor")
                    .components()
                {
                    match component {
                        Component::Normal(name) => resolved.push(name),
                        Component::ParentDir => {
                            return Err(AppError::BadRequest(
                                "publication output cannot traverse a missing directory".into(),
                            ))
                        }
                        Component::CurDir => {}
                        _ => {
                            return Err(AppError::BadRequest(
                                "invalid publication output path".into(),
                            ))
                        }
                    }
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(output_error("inspect publication output ancestor", error)),
        }
    }
    Err(AppError::BadRequest(
        "publication output has no existing ancestor".into(),
    ))
}

fn require_real_directory_if_present(path: &FsPath) -> Result<(), AppError> {
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.file_type().is_symlink() || !info.is_dir() => Err(AppError::BadRequest(
            "publication output must be a real directory, not a symlink".into(),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(output_error("inspect publication output directory", error)),
    }
}

fn output_error(operation: &str, error: std::io::Error) -> AppError {
    AppError::Internal(format!("cannot {operation}: {error}"))
}

fn escape_json_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn write_metadata_exclusive(path: &FsPath, metadata: &serde_json::Value) -> Result<(), AppError> {
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| AppError::Internal(format!("cannot encode package metadata: {error}")))?;
    publication_storage::write_exclusive_synced(path, &bytes)
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

#[cfg(test)]
mod tests {
    use super::super::input;
    use super::super::PreparePublicationPackageRequest;
    use super::*;
    use serde_json::json;

    fn prepared(root: &FsPath, output: PathBuf) -> PreparedInputs {
        let project = root.join("project");
        let staging = root.join("staging");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(staging.join("bin")).unwrap();
        let executable = staging.join("bin/provider");
        std::fs::write(&executable, b"provider\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::write(staging.join("icon.svg"), b"<svg/>\n").unwrap();
        let metadata = json!({
            "agent": {"id":"provider", "name":"Provider", "version":"1.0.0",
                "description":"Test provider", "distribution":{"binary":{"linux-x86_64":{
                    "archive":"https://example.invalid/provider.tar.gz",
                    "cmd":"bin/provider", "sha256":"0".repeat(64)
                }}}},
            "host":{"publisher":"publisher", "compatibility":{"min_app_version":"0.12.0"},
                "assets":{"icon":"icon.svg"}}
        });
        input::prepare(
            1,
            project.canonicalize().unwrap(),
            "provider".into(),
            output,
            PreparePublicationPackageRequest {
                metadata_json: metadata.to_string(),
                staging_directory: staging.display().to_string(),
                target: "linux-x86_64".into(),
            },
        )
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_redirection_rejects_overlap_before_creating_directories() {
        use std::os::unix::fs::symlink;
        for destination in ["project", "staging"] {
            let root = tempfile::tempdir().unwrap();
            let alias = root.path().join("alias");
            let input = prepared(root.path(), alias.join("new-storage"));
            symlink(root.path().join(destination), &alias).unwrap();
            assert!(build_package(input).is_err());
            assert!(!root.path().join(destination).join("new-storage").exists());
            assert_eq!(
                std::fs::read(root.path().join("staging/bin/provider")).unwrap(),
                b"provider\n"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_project_output_does_not_change_external_directory() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let input = prepared(root.path(), output.clone());
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("sentinel"), b"keep").unwrap();
        std::fs::create_dir(&output).unwrap();
        symlink(outside.path(), output.join("1")).unwrap();
        assert!(build_package(input).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("sentinel")).unwrap(),
            b"keep"
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
        assert!(std::fs::symlink_metadata(output.join("1"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn missing_parent_traversal_does_not_create_a_directory_in_the_project() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let alias = root.path().join("alias");
        let input = prepared(root.path(), alias.join("new/../../outside"));
        symlink(root.path().join("project"), &alias).unwrap();
        assert!(build_package(input).is_err());
        assert!(!root.path().join("project/new").exists());
        assert!(!root.path().join("outside").exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("project"))
                .unwrap()
                .count(),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn legitimate_ancestor_alias_builds_outside_the_project_and_staging() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let storage = tempfile::tempdir().unwrap();
        let alias = root.path().join("alias");
        let input = prepared(root.path(), alias.join("bundles"));
        symlink(storage.path(), &alias).unwrap();
        let response = build_package(input).unwrap();
        let archive = PathBuf::from(response.archive_path);
        assert!(archive.starts_with(storage.path().canonicalize().unwrap().join("bundles/1")));
        assert!(archive.is_file());
        assert!(FsPath::new(&response.metadata_path).is_file());
        assert_eq!(
            std::fs::read_dir(root.path().join("project"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn normal_output_builds_a_bundle_beneath_the_project_storage_directory() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let response = build_package(prepared(root.path(), output.clone())).unwrap();
        let archive = PathBuf::from(response.archive_path);
        let bundle = archive.parent().unwrap();
        assert_eq!(
            bundle.parent(),
            Some(output.join("1").canonicalize().unwrap().as_path())
        );
        assert!(uuid::Uuid::parse_str(bundle.file_name().unwrap().to_str().unwrap()).is_ok());
        assert!(archive.is_file());
        assert!(FsPath::new(&response.metadata_path).is_file());
    }
}
