//! Deterministic, local-only packaging for an already prepared provider tree.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::diagnostics::Diagnostics;
use crate::package::validate_package;
use crate::safe_io::read_bounded_regular;
use crate::RegistryError;

mod output;
mod scan;
mod write;

#[derive(bon::Builder)]
pub struct PackProviderRequest<'a> {
    pub package: &'a Path,
    pub target: &'a str,
    pub directory: &'a Path,
    pub output: &'a Path,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PackedProvider {
    pub target: String,
    pub archive: PathBuf,
    pub sha256: String,
    pub size: u64,
}

#[derive(bon::Builder)]
pub struct PackSpec<'a> {
    pub directory: &'a Path,
    pub target: &'a str,
    pub command: &'a str,
    #[builder(default)]
    pub assets: Vec<(&'a str, &'a str)>,
    pub output: &'a Path,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PackedArchive {
    pub sha256: String,
    pub size: u64,
}

pub fn pack_archive(spec: PackSpec<'_>) -> Result<PackedArchive, RegistryError> {
    validate_output_name(spec.output)?;
    let snapshot = scan::collect(spec.directory)?;
    scan::validate_declared_files(
        &snapshot,
        spec.target,
        spec.command,
        spec.assets.iter().copied(),
    )?;
    let built = write::archive(&snapshot, spec.output)?;
    Ok(PackedArchive {
        sha256: built.sha256,
        size: built.size,
    })
}

pub fn pack_provider(request: PackProviderRequest<'_>) -> Result<PackedProvider, RegistryError> {
    validate_output_name(request.output)?;
    let metadata = read_metadata(request.package)?;
    let declared = declared_files(&metadata, request.target)?;
    let archive = absolute_output(request.output)?;
    let mut assets = vec![("icon asset", declared.icon.as_str())];
    if let Some(readme) = declared.readme.as_deref() {
        assets.push(("readme asset", readme));
    }
    if let Some(license) = declared.license.as_deref() {
        assets.push(("license asset", license));
    }
    let built = pack_archive(
        PackSpec::builder()
            .directory(request.directory)
            .target(request.target)
            .command(declared.command.as_str())
            .assets(assets)
            .output(&archive)
            .build(),
    )?;
    Ok(PackedProvider {
        target: request.target.into(),
        archive,
        sha256: built.sha256,
        size: built.size,
    })
}

fn read_metadata(path: &Path) -> Result<Value, RegistryError> {
    let bytes = read_bounded_regular(path, 1024 * 1024)
        .map_err(|error| bad(format!("cannot read package metadata: {error}")))?;
    let value = crate::json::parse_json(&bytes)
        .map_err(|error| bad(format!("invalid package metadata JSON: {error}")))?;
    let mut errors = Diagnostics::default();
    validate_package(&value, "package", &mut errors);
    if errors.is_empty() {
        Ok(value)
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}

struct DeclaredFiles {
    command: String,
    icon: String,
    readme: Option<String>,
    license: Option<String>,
}

fn declared_files(metadata: &Value, target: &str) -> Result<DeclaredFiles, RegistryError> {
    let binary = metadata
        .pointer("/agent/distribution/binary")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("package metadata does not declare binary targets"))?;
    let selected = binary
        .get(target)
        .ok_or_else(|| bad(format!("package metadata does not declare target {target}")))?;
    let string = |pointer: &str| {
        metadata
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(DeclaredFiles {
        command: selected
            .get("cmd")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("selected target has no command"))?
            .into(),
        icon: string("/host/assets/icon").ok_or_else(|| bad("package has no icon asset"))?,
        readme: string("/host/assets/readme"),
        license: string("/host/assets/license"),
    })
}

fn validate_output_name(output: &Path) -> Result<(), RegistryError> {
    if !output
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".tar.gz"))
    {
        return Err(bad("--output must end in .tar.gz"));
    }
    Ok(())
}

fn absolute_output(output: &Path) -> Result<PathBuf, RegistryError> {
    std::path::absolute(output).map_err(|error| {
        bad(format!(
            "cannot resolve absolute archive output path: {error}"
        ))
    })
}

fn bad(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}

struct BuiltArchive {
    sha256: String,
    size: u64,
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::CString;
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    #[test]
    fn source_fifo_swap_fails_without_blocking_and_removes_partial_output() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        let command = staging.join("provider");
        std::fs::write(&command, b"provider").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let snapshot = scan::collect(&staging).unwrap();
        std::fs::remove_file(&command).unwrap();
        let raw = CString::new(command.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o700) }, 0);
        let output = root.path().join("provider.tar.gz");
        assert!(write::archive(&snapshot, &output).is_err());
        assert!(!output.exists());
    }
}
