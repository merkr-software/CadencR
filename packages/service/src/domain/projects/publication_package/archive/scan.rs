use std::collections::HashSet;
use std::fs::Metadata;
use std::path::{Path, PathBuf};

use crate::domain::agents::providers::installed::managed::archive::{
    MAX_ARCHIVE_ENTRIES, MAX_SINGLE_FILE_BYTES, MAX_UNCOMPRESSED_BYTES,
};
use crate::domain::agents::providers::installed::managed::ManagedPackageAssets;
use crate::error::AppError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub(super) len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    mode: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Entry {
    pub relative: PathBuf,
    pub canonical: PathBuf,
    pub directory: bool,
    pub executable: bool,
    pub identity: Identity,
}

#[derive(Clone, Debug)]
pub(super) struct Snapshot {
    pub root: PathBuf,
    pub root_identity: Identity,
    pub entries: Vec<Entry>,
}

pub(super) fn collect(staging: &Path) -> Result<Snapshot, AppError> {
    let input = std::fs::symlink_metadata(staging)
        .map_err(|error| bad(format!("cannot inspect staging directory: {error}")))?;
    if !input.is_dir() || input.file_type().is_symlink() {
        return Err(bad(
            "staging directory must be a real directory, not a symlink",
        ));
    }
    let root = std::fs::canonicalize(staging)
        .map_err(|error| bad(format!("cannot resolve staging directory: {error}")))?;
    let root_identity = identity(&std::fs::symlink_metadata(&root).map_err(io_error)?);
    let mut entries = Vec::new();
    let mut bytes = 0;
    visit(&root, Path::new(""), &mut entries, &mut bytes)?;
    Ok(Snapshot {
        root,
        root_identity,
        entries,
    })
}

fn visit(
    root: &Path,
    relative: &Path,
    entries: &mut Vec<Entry>,
    bytes: &mut u64,
) -> Result<(), AppError> {
    let remaining = MAX_ARCHIVE_ENTRIES.saturating_sub(entries.len());
    let mut children = bounded_children(&root.join(relative), remaining)?;
    children.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });
    let mut portable = HashSet::new();
    for child in children {
        let name = child.file_name();
        let utf8_name = utf8_name(&name, relative)?;
        validate_name(utf8_name, relative, &mut portable)?;
        let child_relative = relative.join(&name);
        let source = root.join(&child_relative);
        let metadata = std::fs::symlink_metadata(&source).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err(bad(format!(
                "symbolic links are forbidden: {}",
                child_relative.display()
            )));
        }
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(bad(format!(
                "special files are forbidden: {}",
                child_relative.display()
            )));
        }
        if metadata.is_file() {
            if metadata.len() > MAX_SINGLE_FILE_BYTES {
                return Err(bad(format!(
                    "file exceeds {MAX_SINGLE_FILE_BYTES} bytes: {}",
                    child_relative.display()
                )));
            }
            *bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| bad("package size overflow"))?;
            if *bytes > MAX_UNCOMPRESSED_BYTES {
                return Err(bad(format!(
                    "package exceeds {MAX_UNCOMPRESSED_BYTES} uncompressed bytes"
                )));
            }
        }
        let canonical = std::fs::canonicalize(&source).map_err(io_error)?;
        if !canonical.starts_with(root) {
            return Err(bad(format!(
                "path escapes staging directory: {}",
                child_relative.display()
            )));
        }
        ensure_capacity(entries.len(), MAX_ARCHIVE_ENTRIES)?;
        entries.push(Entry {
            relative: child_relative.clone(),
            canonical,
            directory: metadata.is_dir(),
            executable: executable(&metadata),
            identity: identity(&metadata),
        });
        if metadata.is_dir() {
            visit(root, &child_relative, entries, bytes)?;
        }
    }
    Ok(())
}

fn bounded_children(
    directory: &Path,
    remaining: usize,
) -> Result<Vec<std::fs::DirEntry>, AppError> {
    let children = std::fs::read_dir(directory)
        .map_err(io_error)?
        .take(remaining.saturating_add(1))
        .collect::<Result<Vec<_>, _>>()
        .map_err(io_error)?;
    if children.len() > remaining {
        return Err(limit_error());
    }
    Ok(children)
}

fn utf8_name<'a>(name: &'a std::ffi::OsStr, parent: &Path) -> Result<&'a str, AppError> {
    name.to_str().ok_or_else(|| {
        bad(format!(
            "non-UTF-8 package path is forbidden under {}",
            parent.display()
        ))
    })
}

fn ensure_capacity(current: usize, limit: usize) -> Result<(), AppError> {
    if current >= limit {
        return Err(limit_error());
    }
    Ok(())
}

fn limit_error() -> AppError {
    bad(format!("package exceeds {MAX_ARCHIVE_ENTRIES} entries"))
}

pub(super) fn validate_declared_files(
    snapshot: &Snapshot,
    target_name: &str,
    command: &str,
    assets: &ManagedPackageAssets,
) -> Result<(), AppError> {
    let files: HashSet<_> = snapshot
        .entries
        .iter()
        .filter(|entry| !entry.directory)
        .map(|entry| &entry.relative)
        .collect();
    for (label, value) in [
        ("entrypoint", Some(command)),
        ("icon asset", Some(assets.icon.as_str())),
        ("readme asset", assets.readme.as_deref()),
        ("license asset", assets.license.as_deref()),
    ] {
        if value.is_some_and(|value| !files.contains(&PathBuf::from(value))) {
            return Err(bad(format!(
                "{label} is missing from staging directory: {}",
                value.unwrap()
            )));
        }
    }
    let executable = snapshot
        .entries
        .iter()
        .find(|entry| entry.relative == Path::new(command));
    if !target_name.starts_with("windows-") && !executable.is_some_and(|entry| entry.executable) {
        return Err(bad(format!("entrypoint is not executable: {command}")));
    }
    Ok(())
}

fn validate_name(name: &str, parent: &Path, seen: &mut HashSet<String>) -> Result<(), AppError> {
    let lower = name.to_lowercase();
    let invalid = name
        .chars()
        .any(|character| character <= '\u{1f}' || "<>:\"\\|?*".contains(character))
        || name.ends_with([' ', '.'])
        || is_windows_device(&lower);
    if invalid {
        return Err(bad(format!(
            "non-portable package path is forbidden: {}",
            parent.join(name).display()
        )));
    }
    if !seen.insert(lower.clone()) {
        return Err(bad(format!(
            "portable path collision is forbidden: {}",
            parent.join(name).display()
        )));
    }
    let secret = matches!(
        lower.as_str(),
        ".env" | ".git" | "id_dsa" | "id_ecdsa" | "id_ed25519" | "id_rsa"
    ) || lower.starts_with(".env.")
        || [".key", ".p12", ".pfx", ".pem"]
            .iter()
            .any(|suffix| lower.ends_with(suffix));
    if secret {
        return Err(bad(format!(
            "secret-prone path is forbidden: {}",
            parent.join(name).display()
        )));
    }
    Ok(())
}

fn is_windows_device(lower: &str) -> bool {
    let stem = lower.split('.').next().unwrap_or(lower);
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || stem.strip_prefix("com").is_some_and(single_device_digit)
        || stem.strip_prefix("lpt").is_some_and(single_device_digit)
}

fn single_device_digit(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|byte| value.len() == 1 && (b'1'..=b'9').contains(byte))
}

pub(super) fn current_identity(path: &Path) -> Result<Identity, AppError> {
    std::fs::symlink_metadata(path)
        .map(|value| identity(&value))
        .map_err(io_error)
}

pub(super) fn metadata_identity(metadata: &Metadata) -> Identity {
    identity(metadata)
}

fn identity(metadata: &Metadata) -> Identity {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;
    Identity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        dev: metadata.dev(),
        #[cfg(unix)]
        ino: metadata.ino(),
        #[cfg(unix)]
        mode: metadata.mode(),
    }
}

#[cfg(unix)]
fn executable(metadata: &Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    metadata.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn executable(_metadata: &Metadata) -> bool {
    true
}

fn bad(message: impl Into<String>) -> AppError {
    AppError::BadRequest(message.into())
}
fn io_error(error: std::io::Error) -> AppError {
    AppError::Internal(format!("package archive I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{bounded_children, ensure_capacity, utf8_name};

    #[test]
    fn directory_enumeration_stops_at_the_remaining_budget() {
        let root = tempfile::tempdir().unwrap();
        for name in ["one", "two", "three"] {
            std::fs::write(root.path().join(name), name).unwrap();
        }
        let error = bounded_children(root.path(), 2).unwrap_err();
        assert!(error.to_string().contains("exceeds 4096 entries"));
        assert_eq!(bounded_children(root.path(), 3).unwrap().len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_utf8_file_names() {
        use std::os::unix::ffi::OsStringExt as _;

        let name = std::ffi::OsString::from_vec(vec![b'f', 0x80]);
        let error = utf8_name(&name, std::path::Path::new("nested")).unwrap_err();
        assert!(error.to_string().contains("non-UTF-8 package path"));
    }

    #[test]
    fn recursive_sibling_push_cannot_exceed_consumed_global_budget() {
        assert!(ensure_capacity(2, 3).is_ok());
        assert!(ensure_capacity(3, 3).is_err());
    }
}
