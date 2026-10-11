use std::fs::{self, File, OpenOptions};
use std::io::Read as _;
use std::path::Path;

pub(crate) fn read_bounded_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(std::io::Error::other(
            "must be a regular file (symlinks and special files are forbidden)",
        ));
    }
    if before.len() > limit {
        return Err(std::io::Error::other(format!(
            "exceeds the {limit}-byte file limit"
        )));
    }
    let file = open_regular(path, &before)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(std::io::Error::other(format!(
            "exceeds the {limit}-byte file limit"
        )));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(std::io::Error::other("changed while being read"));
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_regular(path: &Path, before: &fs::Metadata) -> std::io::Result<File> {
    let file = OpenOptions::new().read(true).open(path)?;
    let after = file.metadata()?;
    if !after.is_file() || before.len() != after.len() {
        return Err(std::io::Error::other("changed while being read"));
    }
    Ok(file)
}
