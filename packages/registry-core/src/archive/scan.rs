use std::collections::HashSet;
use std::fs::Metadata;
use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization as _;

use crate::RegistryError;

pub(super) const MAX_ARCHIVE_ENTRIES: usize = 4_096;
pub(super) const MAX_UNCOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const MAX_SINGLE_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Identity {
    pub(super) len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    ctime: i64,
    #[cfg(unix)]
    ctime_nsec: i64,
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

pub(super) fn collect(staging: &Path) -> Result<Snapshot, RegistryError> {
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
    visit(&root, Path::new(""), 0, &mut entries, &mut bytes)?;
    Ok(Snapshot {
        root,
        root_identity,
        entries,
    })
}

fn visit(
    root: &Path,
    relative: &Path,
    depth: usize,
    entries: &mut Vec<Entry>,
    bytes: &mut u64,
) -> Result<(), RegistryError> {
    if depth > MAX_DIRECTORY_DEPTH {
        return Err(bad(format!(
            "package exceeds {MAX_DIRECTORY_DEPTH} directory levels"
        )));
    }
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
        validate_file_type(&metadata, &child_relative)?;
        account_file(&metadata, &child_relative, bytes)?;
        let canonical = std::fs::canonicalize(&source).map_err(io_error)?;
        if !canonical.starts_with(root) {
            return Err(bad(format!(
                "path escapes staging directory: {}",
                child_relative.display()
            )));
        }
        if entries.len() >= MAX_ARCHIVE_ENTRIES {
            return Err(limit_error());
        }
        entries.push(Entry {
            relative: child_relative.clone(),
            canonical,
            directory: metadata.is_dir(),
            executable: executable(&metadata),
            identity: identity(&metadata),
        });
        if metadata.is_dir() {
            visit(root, &child_relative, depth + 1, entries, bytes)?;
        }
    }
    Ok(())
}

fn validate_file_type(metadata: &Metadata, path: &Path) -> Result<(), RegistryError> {
    if metadata.file_type().is_symlink() {
        return Err(bad(format!(
            "symbolic links are forbidden: {}",
            path.display()
        )));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(bad(format!(
            "special files are forbidden: {}",
            path.display()
        )));
    }
    Ok(())
}

fn account_file(metadata: &Metadata, path: &Path, total: &mut u64) -> Result<(), RegistryError> {
    if !metadata.is_file() {
        return Ok(());
    }
    if metadata.len() > MAX_SINGLE_FILE_BYTES {
        return Err(bad(format!(
            "file exceeds {MAX_SINGLE_FILE_BYTES} bytes: {}",
            path.display()
        )));
    }
    *total = total
        .checked_add(metadata.len())
        .ok_or_else(|| bad("package size overflow"))?;
    if *total > MAX_UNCOMPRESSED_BYTES {
        return Err(bad(format!(
            "package exceeds {MAX_UNCOMPRESSED_BYTES} uncompressed bytes"
        )));
    }
    Ok(())
}

fn bounded_children(
    directory: &Path,
    remaining: usize,
) -> Result<Vec<std::fs::DirEntry>, RegistryError> {
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

fn utf8_name<'a>(name: &'a std::ffi::OsStr, parent: &Path) -> Result<&'a str, RegistryError> {
    name.to_str().ok_or_else(|| {
        bad(format!(
            "non-UTF-8 package path is forbidden under {}",
            parent.display()
        ))
    })
}

pub(super) fn validate_declared_files<'a>(
    snapshot: &Snapshot,
    target: &str,
    command: &'a str,
    assets: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<(), RegistryError> {
    let files: HashSet<_> = snapshot
        .entries
        .iter()
        .filter(|entry| !entry.directory)
        .map(|entry| &entry.relative)
        .collect();
    for (label, value) in std::iter::once(("entrypoint", command)).chain(assets) {
        if !files.contains(&PathBuf::from(value)) {
            return Err(bad(format!(
                "{label} is missing from staging directory: {value}"
            )));
        }
    }
    let command_entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.relative == Path::new(command));
    if !target.starts_with("windows-") && !command_entry.is_some_and(|entry| entry.executable) {
        return Err(bad(format!("entrypoint is not executable: {}", command)));
    }
    Ok(())
}

fn validate_name(
    name: &str,
    parent: &Path,
    seen: &mut HashSet<String>,
) -> Result<(), RegistryError> {
    let lower = name.nfc().collect::<String>().to_lowercase();
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
    reject_secret(&lower, name, parent)
}

fn reject_secret(lower: &str, name: &str, parent: &Path) -> Result<(), RegistryError> {
    let secret = matches!(
        lower,
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

pub(super) fn current_identity(path: &Path) -> Result<Identity, RegistryError> {
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
        created: metadata.created().ok(),
        #[cfg(unix)]
        dev: metadata.dev(),
        #[cfg(unix)]
        ino: metadata.ino(),
        #[cfg(unix)]
        mode: metadata.mode(),
        #[cfg(unix)]
        ctime: metadata.ctime(),
        #[cfg(unix)]
        ctime_nsec: metadata.ctime_nsec(),
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

fn limit_error() -> RegistryError {
    bad(format!("package exceeds {MAX_ARCHIVE_ENTRIES} entries"))
}
fn bad(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}
fn io_error(error: std::io::Error) -> RegistryError {
    bad(format!("package archive I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_excessive_directory_depth_before_recursing_further() {
        let root = tempfile::tempdir().unwrap();
        let mut directory = root.path().to_path_buf();
        for _ in 0..=MAX_DIRECTORY_DEPTH {
            directory.push("d");
            std::fs::create_dir(&directory).unwrap();
        }
        let error = collect(root.path()).unwrap_err();
        assert!(error.to_string().contains("directory levels"));
    }
}
