use std::path::{Component, Path, PathBuf};

use super::super::download::{ArtifactError, ArtifactErrorCode};

pub(super) fn prepare_package_root(root: &Path) -> Result<(), ArtifactError> {
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(ArtifactError::new(
                ArtifactErrorCode::UnsafeArchive,
                format!("package root {} is not a real directory", root.display()),
            ));
        }
        Ok(_) => {
            if std::fs::read_dir(root)
                .map_err(|error| ArtifactError::archive_io("inspect package root", error))?
                .next()
                .is_some()
            {
                return Err(ArtifactError::new(
                    ArtifactErrorCode::UnsafeArchive,
                    format!("package root {} must be empty", root.display()),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(root)
                .map_err(|error| ArtifactError::archive_io("create package root", error))?;
        }
        Err(error) => return Err(ArtifactError::archive_io("inspect package root", error)),
    }
    set_permissions(root, 0o700)
}

pub(super) fn create_directory(root: &Path, relative: &Path) -> Result<(), ArtifactError> {
    let path = root.join(relative);
    std::fs::create_dir_all(&path)
        .map_err(|error| ArtifactError::archive_io("create extracted directory", error))?;
    set_permissions(&path, 0o755)
}

pub(super) fn normalize_package_path(raw: &Path, role: &str) -> Result<PathBuf, ArtifactError> {
    let rendered = raw.to_string_lossy();
    if rendered.contains('\\') || rendered.contains('\0') || rendered.contains(':') {
        return Err(ArtifactError::outside(format!(
            "{role} path {rendered:?} is not portable"
        )));
    }
    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ArtifactError::outside(format!(
                    "{role} path {} escapes the package root",
                    raw.display()
                )));
            }
        }
    }
    Ok(normalized)
}

pub(super) fn validate_mode(
    mode: Option<u32>,
    is_dir: bool,
    path: &Path,
) -> Result<(), ArtifactError> {
    let Some(mode) = mode else { return Ok(()) };
    let file_type = mode & 0o170000;
    let expected_type = if is_dir { 0o040000 } else { 0o100000 };
    if (file_type != 0 && file_type != expected_type) || mode & 0o7022 != 0 {
        return Err(ArtifactError::new(
            ArtifactErrorCode::UnsafePermissions,
            format!("archive path {} has unsafe mode {mode:#o}", path.display()),
        ));
    }
    Ok(())
}

pub(super) fn safe_file_mode(mode: Option<u32>) -> u32 {
    if mode.is_some_and(|value| value & 0o111 != 0) {
        0o755
    } else {
        0o644
    }
}

#[cfg(unix)]
pub(super) fn set_permissions(path: &Path, mode: u32) -> Result<(), ArtifactError> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|error| ArtifactError::archive_io("set extracted path permissions", error))
}

#[cfg(not(unix))]
pub(super) fn set_permissions(_path: &Path, _mode: u32) -> Result<(), ArtifactError> {
    Ok(())
}
