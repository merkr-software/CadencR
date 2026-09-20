use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::diagnostics::Diagnostics;

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_ROOT_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) struct Tree {
    pub packages: BTreeMap<String, Value>,
    pub submissions: BTreeMap<String, Value>,
}

pub(crate) fn load_tree(root: &Path, label: &str, errors: &mut Diagnostics) -> Option<Tree> {
    let Ok(metadata) = fs::symlink_metadata(root) else {
        errors.push(format!("{label}: does not exist"));
        return None;
    };
    if metadata.file_type().is_symlink() {
        errors.push(format!("{label}: symlinks are forbidden"));
        return None;
    }
    if !metadata.is_dir() {
        errors.push(format!("{label}: must be a directory"));
        return None;
    }
    let mut budget = 0;
    let packages = load_directory(
        &root.join("packages"),
        &format!("{label}/packages"),
        true,
        &mut budget,
        errors,
    )?;
    let submissions = load_directory(
        &root.join("submissions"),
        &format!("{label}/submissions"),
        false,
        &mut budget,
        errors,
    )?;
    Some(Tree {
        packages,
        submissions,
    })
}

fn load_directory(
    directory: &Path,
    label: &str,
    required: bool,
    budget: &mut u64,
    errors: &mut Diagnostics,
) -> Option<BTreeMap<String, Value>> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(value) => value,
        Err(error) if !required && error.kind() == std::io::ErrorKind::NotFound => {
            return Some(BTreeMap::new())
        }
        Err(error) => {
            errors.push(format!("{label}: {error}"));
            return None;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        errors.push(format!(
            "{label}: must be a real directory, not a symlink or special file"
        ));
        return None;
    }
    let mut entries = read_entries(directory, label, errors)?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    let mut result = BTreeMap::new();
    for entry in entries {
        if errors.is_full() {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            errors.push(format!("{label}/{name}: disappeared while being validated"));
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            errors.push(format!(
                "{label}/{name}: must be a regular file (symlinks and special files are forbidden)"
            ));
            continue;
        }
        if name == ".gitkeep" {
            continue;
        }
        if !name.ends_with(".json") {
            errors.push(format!("{label}/{name}: only .json files are allowed"));
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES {
            errors.push(format!(
                "{label}/{name}: exceeds the {MAX_FILE_BYTES}-byte file limit"
            ));
            continue;
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        match open_regular(&path, &metadata)
            .and_then(|file| file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes))
        {
            Ok(_) if bytes.len() as u64 <= MAX_FILE_BYTES => {
                *budget += bytes.len() as u64;
                if *budget > MAX_ROOT_BYTES {
                    errors.push(format!(
                        "{label}: root exceeds the {MAX_ROOT_BYTES}-byte JSON total limit"
                    ));
                    return Some(result);
                }
                match crate::json::parse_json(&bytes) {
                    Ok(value) => {
                        result.insert(name, value);
                    }
                    Err(error) => errors.push(format!("{label}/{name}: invalid JSON ({error})")),
                }
            }
            Ok(_) => errors.push(format!(
                "{label}/{name}: exceeds the {MAX_FILE_BYTES}-byte file limit"
            )),
            Err(error) => errors.push(format!("{label}/{name}: {error}")),
        }
    }
    Some(result)
}

fn read_entries(
    directory: &Path,
    label: &str,
    errors: &mut Diagnostics,
) -> Option<Vec<fs::DirEntry>> {
    let read = match fs::read_dir(directory) {
        Ok(read) => read,
        Err(error) => {
            errors.push(format!("{label}: {error}"));
            return None;
        }
    };
    let mut entries = Vec::new();
    for entry in read.take(MAX_FILES + 1) {
        match entry {
            Ok(entry) => entries.push(entry),
            Err(error) => {
                errors.push(format!("{label}: {error}"));
                return None;
            }
        }
    }
    if entries.len() > MAX_FILES {
        errors.push(format!("{label}: exceeds the {MAX_FILES} entry limit"));
        return None;
    }
    Some(entries)
}

#[cfg(unix)]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(std::io::Error::other("changed while being validated"));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    let file = OpenOptions::new().read(true).open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.len() != after.len() {
        return Err(std::io::Error::other("changed while being validated"));
    }
    Ok(file)
}

pub(crate) fn load_packages(
    directory: &Path,
    errors: &mut Diagnostics,
) -> Option<BTreeMap<String, Value>> {
    load_directory(directory, "packages", true, &mut 0, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_invalid_json_without_panicking() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("packages")).unwrap();
        std::fs::write(root.path().join("packages/bad.json"), b"{").unwrap();
        let mut errors = Diagnostics::default();
        let packages = load_packages(&root.path().join("packages"), &mut errors).unwrap();
        assert!(packages.is_empty());
        assert!(errors.iter().any(|error| error.contains("invalid JSON")));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_fifo_entries_without_following_or_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let root = tempfile::tempdir().unwrap();
        let packages = root.path().join("packages");
        std::fs::create_dir(&packages).unwrap();
        std::fs::write(root.path().join("target.json"), b"{}").unwrap();
        std::os::unix::fs::symlink(root.path().join("target.json"), packages.join("link.json"))
            .unwrap();
        let fifo = packages.join("pipe.json");
        let fifo = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: `fifo` is a valid, NUL-terminated path owned for the duration of the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let mut errors = Diagnostics::default();
        let loaded = load_packages(&packages, &mut errors).unwrap();
        assert!(loaded.is_empty());
        assert_eq!(
            errors
                .iter()
                .filter(|error| error.contains("regular file"))
                .count(),
            2
        );
    }

    #[test]
    fn enforces_aggregate_actual_byte_budget() {
        let root = tempfile::tempdir().unwrap();
        let packages = root.path().join("packages");
        std::fs::create_dir(&packages).unwrap();
        let document = format!("\"{}\"", "x".repeat(MAX_FILE_BYTES as usize - 2));
        for index in 0..33 {
            std::fs::write(packages.join(format!("{index:02}.json")), &document).unwrap();
        }
        let mut errors = Diagnostics::default();
        let loaded = load_packages(&packages, &mut errors).unwrap();
        assert_eq!(loaded.len(), 32);
        assert!(errors
            .iter()
            .any(|error| error.contains("JSON total limit")));
    }
}
