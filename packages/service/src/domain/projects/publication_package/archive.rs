//! Deterministic, local-only packaging for an already prepared provider tree.

use std::path::Path;

use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;
use crate::error::AppError;

mod scan;
mod write;

#[derive(bon::Builder)]
pub(super) struct ArchiveBuildRequest<'a> {
    pub staging: &'a Path,
    pub target: &'a str,
    pub package: &'a ManagedProviderPackage,
    pub output: &'a Path,
}

#[derive(Debug)]
pub(super) struct BuiltArchive {
    pub sha256: String,
    pub size: u64,
}

pub(super) fn build(request: ArchiveBuildRequest<'_>) -> Result<BuiltArchive, AppError> {
    let target = request
        .package
        .agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.binary.as_ref())
        .and_then(|binary| binary.get(request.target))
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "package metadata does not declare target {}",
                request.target
            ))
        })?;
    let snapshot = scan::collect(request.staging)?;
    scan::validate_declared_files(
        &snapshot,
        request.target,
        &target.cmd,
        &request.package.host.assets,
    )?;
    write::archive(&snapshot, request.output)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use flate2::read::GzDecoder;
    use serde_json::json;
    use sha2::{Digest as _, Sha256};

    use super::{build, ArchiveBuildRequest};
    use crate::domain::agents::providers::installed::managed::ManagedProviderPackage;

    struct Fixture {
        _root: tempfile::TempDir,
        staging: PathBuf,
        package: ManagedProviderPackage,
    }

    fn new_fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("staging");
        std::fs::create_dir_all(staging.join("bin")).unwrap();
        std::fs::create_dir(staging.join("assets")).unwrap();
        std::fs::write(staging.join("bin/provider"), b"provider\n").unwrap();
        make_executable(&staging.join("bin/provider"));
        std::fs::write(staging.join("assets/icon.svg"), b"<svg/>\n").unwrap();
        std::fs::write(staging.join("README.md"), b"readme\n").unwrap();
        std::fs::write(staging.join("LICENSE"), b"license\n").unwrap();
        let package = serde_json::from_value(json!({
            "agent": {
                "id": "provider", "name": "Provider", "version": "1.0.0",
                "description": "Test provider",
                "distribution": { "binary": { "darwin-aarch64": {
                    "archive": "https://example.invalid/provider.tar.gz",
                    "cmd": "bin/provider", "sha256": "0".repeat(64)
                }}}
            },
            "host": {
                "publisher": "publisher",
                "compatibility": { "min_app_version": "0.12.0" },
                "assets": { "icon": "assets/icon.svg", "readme": "README.md", "license": "LICENSE" }
            }
        }))
        .unwrap();
        Fixture {
            _root: root,
            staging,
            package,
        }
    }

    fn run(
        fixture: &Fixture,
        output: &Path,
    ) -> Result<super::BuiltArchive, crate::error::AppError> {
        build(
            ArchiveBuildRequest::builder()
                .staging(&fixture.staging)
                .target("darwin-aarch64")
                .package(&fixture.package)
                .output(output)
                .build(),
        )
    }

    #[test]
    fn archive_is_deterministic_extractable_and_digest_bound() {
        let fixture = new_fixture();
        let first_path = fixture._root.path().join("one.tar.gz");
        let second_path = fixture._root.path().join("two.tar.gz");
        let first = run(&fixture, &first_path).unwrap();
        let second = run(&fixture, &second_path).unwrap();
        let first_bytes = std::fs::read(&first_path).unwrap();
        assert_eq!(first_bytes, std::fs::read(second_path).unwrap());
        assert_eq!(
            first.sha256,
            Sha256::digest(&first_bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(first.size, first_bytes.len() as u64);
        assert_eq!(first.sha256, second.sha256);
        let verified =
            crate::domain::agents::providers::installed::managed::download::verify_local_artifact(
                &first_path,
                "provider.tar.gz",
                &first.sha256,
            )
            .unwrap();
        let extracted =
            crate::domain::agents::providers::installed::managed::archive::extract_verified(
                &verified,
                &fixture._root.path().join("installed"),
                "bin/provider",
            )
            .unwrap();
        assert_eq!(
            std::fs::read(extracted.executable()).unwrap(),
            std::fs::read(fixture.staging.join("bin/provider")).unwrap()
        );
        let mut archive = tar::Archive::new(GzDecoder::new(first_bytes.as_slice()));
        let paths = archive
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                "LICENSE",
                "README.md",
                "assets",
                "assets/icon.svg",
                "bin",
                "bin/provider"
            ]
        );
    }

    #[test]
    fn rejects_missing_declared_file_non_executable_and_overwrite() {
        let fixture = new_fixture();
        std::fs::remove_file(fixture.staging.join("assets/icon.svg")).unwrap();
        let output = fixture._root.path().join("missing.tar.gz");
        assert!(run(&fixture, &output)
            .unwrap_err()
            .to_string()
            .contains("icon asset is missing"));

        let fixture = new_fixture();
        make_not_executable(&fixture.staging.join("bin/provider"));
        assert!(run(&fixture, &fixture._root.path().join("mode.tar.gz"))
            .unwrap_err()
            .to_string()
            .contains("not executable"));

        let fixture = new_fixture();
        let output = fixture._root.path().join("exists.tar.gz");
        std::fs::write(&output, "keep").unwrap();
        assert!(run(&fixture, &output).is_err());
        assert_eq!(std::fs::read_to_string(output).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_special_files_and_secret_names() {
        use std::os::unix::fs::{symlink, FileTypeExt as _};
        let fixture = new_fixture();
        symlink("README.md", fixture.staging.join("linked")).unwrap();
        assert!(run(&fixture, &fixture._root.path().join("link.tar.gz"))
            .unwrap_err()
            .to_string()
            .contains("symbolic links"));

        let fixture = new_fixture();
        let fifo = fixture.staging.join("pipe");
        let path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(std::fs::symlink_metadata(&fifo)
            .unwrap()
            .file_type()
            .is_fifo());
        assert!(run(&fixture, &fixture._root.path().join("fifo.tar.gz"))
            .unwrap_err()
            .to_string()
            .contains("special files"));

        let fixture = new_fixture();
        std::fs::write(fixture.staging.join(".env.production"), "secret").unwrap();
        assert!(run(&fixture, &fixture._root.path().join("secret.tar.gz"))
            .unwrap_err()
            .to_string()
            .contains("secret-prone"));
    }

    #[test]
    fn failed_archive_is_removed() {
        let fixture = new_fixture();
        let output = fixture._root.path().join("nested/missing/out.tar.gz");
        assert!(run(&fixture, &output).is_err());
        assert!(!output.exists());
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}
    #[cfg(unix)]
    fn make_not_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    #[cfg(not(unix))]
    fn make_not_executable(_path: &Path) {}
}
