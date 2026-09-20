use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use flate2::{Compression, GzBuilder};
use sha2::{Digest as _, Sha256};

use super::scan::{self, Entry, Snapshot};
use super::BuiltArchive;
use crate::domain::agents::providers::installed::managed::download::MAX_ARTIFACT_DOWNLOAD_BYTES;
use crate::error::AppError;

pub(super) fn archive(snapshot: &Snapshot, output: &Path) -> Result<BuiltArchive, AppError> {
    reject_output_location(snapshot, output)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)
        .map_err(|error| AppError::Internal(format!("cannot create package archive: {error}")))?;
    match write_owned(snapshot, file) {
        Ok(result) => Ok(result),
        Err(primary) => match std::fs::remove_file(output) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(AppError::Internal(format!(
                "{primary}; cleanup of failed package archive also failed: {cleanup}"
            ))),
        },
    }
}

fn reject_output_location(snapshot: &Snapshot, output: &Path) -> Result<(), AppError> {
    let parent = output.parent().ok_or_else(|| {
        AppError::BadRequest("archive output must have a parent directory".into())
    })?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
        AppError::BadRequest(format!("cannot resolve archive output directory: {error}"))
    })?;
    if canonical_parent.starts_with(&snapshot.root) {
        return Err(AppError::BadRequest(
            "archive output must not be inside staging directory".into(),
        ));
    }
    Ok(())
}

fn write_owned(snapshot: &Snapshot, file: File) -> Result<BuiltArchive, AppError> {
    let digest = DigestWriter::new(file);
    // A fixed level keeps repeated archives identical within this runtime while
    // avoiding the CPU cost of maximum compression for large local packages.
    let gzip = GzBuilder::new()
        .mtime(0)
        .write(digest, Compression::default());
    let mut tar = tar::Builder::new(gzip);
    tar.mode(tar::HeaderMode::Deterministic);
    for entry in &snapshot.entries {
        append(snapshot, entry, &mut tar)?;
    }
    tar.finish().map_err(io_error)?;
    let gzip = tar.into_inner().map_err(io_error)?;
    let digest = gzip.finish().map_err(io_error)?;
    verify_snapshot(snapshot)?;
    digest.file.sync_all().map_err(io_error)?;
    Ok(digest.finish())
}

fn append<W: Write>(
    snapshot: &Snapshot,
    entry: &Entry,
    tar: &mut tar::Builder<W>,
) -> Result<(), AppError> {
    verify_entry(snapshot, entry)?;
    let mut header = tar::Header::new_ustar();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_mode(if entry.directory {
        0o755
    } else if entry.executable {
        0o755
    } else {
        0o644
    });
    header.set_entry_type(if entry.directory {
        tar::EntryType::Directory
    } else {
        tar::EntryType::Regular
    });
    header.set_size(if entry.directory {
        0
    } else {
        entry.identity_len()
    });
    header.set_cksum();
    if entry.directory {
        tar.append_data(&mut header, &entry.relative, io::empty())
            .map_err(io_error)
    } else {
        let mut file = open_source(&snapshot.root.join(&entry.relative))?;
        if scan::current_identity(&snapshot.root.join(&entry.relative))? != entry.identity {
            return Err(changed(entry));
        }
        tar.append_data(
            &mut header,
            &entry.relative,
            (&mut file).take(entry.identity_len() + 1),
        )
        .map_err(io_error)?;
        if scan::metadata_identity(&file.metadata().map_err(io_error)?) != entry.identity {
            return Err(changed(entry));
        }
        Ok(())
    }
}

fn verify_entry(snapshot: &Snapshot, entry: &Entry) -> Result<(), AppError> {
    let path = snapshot.root.join(&entry.relative);
    let canonical = std::fs::canonicalize(&path).map_err(io_error)?;
    if canonical != entry.canonical
        || !canonical.starts_with(&snapshot.root)
        || scan::current_identity(&path)? != entry.identity
    {
        return Err(changed(entry));
    }
    Ok(())
}

fn verify_snapshot(snapshot: &Snapshot) -> Result<(), AppError> {
    if scan::current_identity(&snapshot.root)? != snapshot.root_identity {
        return Err(AppError::BadRequest(
            "staging root changed while packaging".into(),
        ));
    }
    let after = scan::collect(&snapshot.root)?;
    if after.entries != snapshot.entries {
        return Err(AppError::BadRequest(
            "staging tree changed while packaging".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn open_source(path: &Path) -> Result<File, AppError> {
    use std::os::unix::fs::OpenOptionsExt as _;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(io_error)
}
#[cfg(not(unix))]
fn open_source(path: &Path) -> Result<File, AppError> {
    File::open(path).map_err(io_error)
}

fn changed(entry: &Entry) -> AppError {
    AppError::BadRequest(format!(
        "file changed while packaging: {}",
        entry.relative.display()
    ))
}
fn io_error(error: io::Error) -> AppError {
    AppError::Internal(format!("package archive I/O failed: {error}"))
}

struct DigestWriter {
    file: File,
    hash: Sha256,
    size: u64,
}
impl DigestWriter {
    fn new(file: File) -> Self {
        Self {
            file,
            hash: Sha256::new(),
            size: 0,
        }
    }
    fn finish(self) -> BuiltArchive {
        BuiltArchive {
            sha256: self
                .hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            size: self.size,
        }
    }
}
impl Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next_size = self
            .size
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("package archive size overflow"))?;
        if next_size > MAX_ARTIFACT_DOWNLOAD_BYTES {
            return Err(io::Error::other(format!(
                "package archive exceeds {MAX_ARTIFACT_DOWNLOAD_BYTES} compressed bytes"
            )));
        }
        self.file.write_all(bytes)?;
        self.hash.update(bytes);
        self.size = next_size;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Entry {
    fn identity_len(&self) -> u64 {
        self.identity.len
    }
}
