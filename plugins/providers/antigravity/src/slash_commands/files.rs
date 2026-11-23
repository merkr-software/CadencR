use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use super::FILE_LIMIT;

/// An inaccessible customization is local to one entry. Report it and keep
/// scanning siblings. Propagate unrelated I/O failures to the host.
pub(super) fn optional<T>(path: &Path, result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(error) if inaccessible(&error) => {
            eprintln!(
                "Skipping inaccessible Antigravity customization {}: {error}",
                path.display()
            );
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn inaccessible(error: &io::Error) -> bool {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return true;
    }
    error.kind() == io::ErrorKind::PermissionDenied
}

pub(super) fn optional_file(path: &Path) -> io::Result<Option<fs::File>> {
    if optional(path, fs::metadata(path))?.is_some_and(|metadata| metadata.is_file()) {
        optional(path, fs::File::open(path))
    } else {
        Ok(None)
    }
}

pub(super) fn read_bounded(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = optional_file(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() > FILE_LIMIT as usize {
        eprintln!(
            "Skipping oversized Antigravity configuration {}",
            path.display()
        );
        return Ok(None);
    }
    Ok(Some(bytes))
}

pub(super) fn children(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    if let Some(entries) = optional(dir, fs::read_dir(dir))? {
        for entry in entries {
            if let Some(entry) = optional(dir, entry)? {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    Ok(paths)
}
