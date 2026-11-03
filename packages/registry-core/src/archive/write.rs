use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use flate2::write::GzEncoder;
use flate2::{Compression, GzBuilder};
use sha2::{Digest as _, Sha256};

use super::output::CreatedOutput;
use super::scan::{self, Entry, Snapshot};
use super::BuiltArchive;
use crate::{RegistryError, MAX_TAB_BACKEND_ARCHIVE_BYTES};

const BLOCK: usize = 512;
const MAX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) fn archive(snapshot: &Snapshot, output: &Path) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(&snapshot.root, output)?;
    archive_with(snapshot, output, write_owned)
}

/// Declarative files carry no executable mode, regardless of host platform.
pub(crate) fn declarative_archive(
    snapshot: &Snapshot,
    output: &Path,
) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(&snapshot.root, output)?;
    archive_with(snapshot, output, |snapshot, file| {
        write_owned_with_mode(snapshot, file, true)
    })
}

pub(crate) fn web_archive(
    snapshot: &Snapshot,
    output: &Path,
) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(&snapshot.root, output)?;
    archive_with(snapshot, output, |snapshot, file| {
        write_owned_with_policy(snapshot, file, true, true, MAX_COMPRESSED_BYTES)
    })
}

/// Prepared LSP Node bundles: normalized files only, with a smaller download budget.
pub(crate) fn lsp_bundle_archive(
    snapshot: &Snapshot,
    output: &Path,
) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(&snapshot.root, output)?;
    archive_with(snapshot, output, |snapshot, file| {
        write_owned_with_policy(snapshot, file, true, true, crate::MAX_LSP_ARCHIVE_BYTES)
    })
}

fn archive_with(
    snapshot: &Snapshot,
    output: &Path,
    write: impl FnOnce(&Snapshot, File) -> Result<BuiltArchive, RegistryError>,
) -> Result<BuiltArchive, RegistryError> {
    let created = CreatedOutput::create(output)?;
    let result = write(snapshot, created.try_clone()?)?;
    created.publish(result)
}

/// A tab backend archive: exactly one regular-file entry `name` holding
/// `bytes`, mode 0755 (the only archive kind that keeps an execute bit),
/// owner 0:0, mtime 0, no directory entries, at most
/// [`MAX_TAB_BACKEND_ARCHIVE_BYTES`] compressed (enforced while writing).
pub(crate) fn single_executable_archive(
    name: &str,
    bytes: &[u8],
    source_root: &Path,
    output: &Path,
) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(source_root, output)?;
    let created = CreatedOutput::create(output)?;
    let mut gzip = gzip_writer(created.try_clone()?, MAX_TAB_BACKEND_ARCHIVE_BYTES);
    gzip.write_all(&header_block(name, 0o755, bytes.len() as u64, b'0')?)
        .and_then(|()| gzip.write_all(bytes))
        .and_then(|()| gzip.write_all(&vec![0; (BLOCK - bytes.len() % BLOCK) % BLOCK]))
        .and_then(|()| gzip.write_all(&[0; BLOCK * 2]))
        .map_err(io_error)?;
    let digest = gzip.finish().map_err(io_error)?;
    digest.file.sync_all().map_err(io_error)?;
    created.publish(digest.finish())
}

/// The deterministic gzip stream every archive is written through, hashed
/// and capped at `limit` compressed bytes.
fn gzip_writer(file: File, limit: u64) -> GzEncoder<DigestWriter> {
    GzBuilder::new()
        .mtime(0)
        .operating_system(19)
        .write(DigestWriter::new(file, limit), Compression::best())
}

fn reject_output_location(root: &Path, output: &Path) -> Result<(), RegistryError> {
    let parent = output
        .parent()
        .ok_or_else(|| bad("archive output must have a parent directory"))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| bad(format!("cannot resolve archive output directory: {error}")))?;
    if canonical_parent.starts_with(root) {
        return Err(bad("output must not be inside staging directory"));
    }
    Ok(())
}

fn write_owned(snapshot: &Snapshot, file: File) -> Result<BuiltArchive, RegistryError> {
    write_owned_with_mode(snapshot, file, false)
}

fn write_owned_with_mode(
    snapshot: &Snapshot,
    file: File,
    declarative: bool,
) -> Result<BuiltArchive, RegistryError> {
    write_owned_with_policy(snapshot, file, declarative, false, MAX_COMPRESSED_BYTES)
}

fn write_owned_with_policy(
    snapshot: &Snapshot,
    file: File,
    declarative: bool,
    files_only: bool,
    limit: u64,
) -> Result<BuiltArchive, RegistryError> {
    let mut gzip = gzip_writer(file, limit);
    for entry in &snapshot.entries {
        if files_only && entry.directory {
            continue;
        }
        append(snapshot, entry, &mut gzip, declarative)?;
    }
    gzip.write_all(&[0; BLOCK * 2]).map_err(io_error)?;
    let digest = gzip.finish().map_err(io_error)?;
    verify_snapshot(snapshot)?;
    digest.file.sync_all().map_err(io_error)?;
    Ok(digest.finish())
}

fn append(
    snapshot: &Snapshot,
    entry: &Entry,
    output: &mut impl Write,
    declarative: bool,
) -> Result<(), RegistryError> {
    verify_entry(snapshot, entry)?;
    output
        .write_all(&tar_header(entry, entry.identity.len, declarative)?)
        .map_err(io_error)?;
    if !entry.directory {
        write_file(snapshot, entry, output)?;
        let padding = (BLOCK - entry.identity.len as usize % BLOCK) % BLOCK;
        output.write_all(&vec![0; padding]).map_err(io_error)?;
    }
    Ok(())
}

fn write_file(
    snapshot: &Snapshot,
    entry: &Entry,
    output: &mut impl Write,
) -> Result<(), RegistryError> {
    let path = snapshot.root.join(&entry.relative);
    let mut file = open_source(&path)?;
    if scan::metadata_identity(&file.metadata().map_err(io_error)?) != entry.identity {
        return Err(changed(entry));
    }
    let mut limited = (&mut file).take(entry.identity.len + 1);
    let written = io::copy(&mut limited, output).map_err(io_error)?;
    if written != entry.identity.len {
        return Err(changed(entry));
    }
    if scan::metadata_identity(&file.metadata().map_err(io_error)?) != entry.identity {
        return Err(changed(entry));
    }
    Ok(())
}

fn tar_header(entry: &Entry, size: u64, declarative: bool) -> Result<[u8; BLOCK], RegistryError> {
    let mut archive_path = entry.relative.to_string_lossy().replace('\\', "/");
    if entry.directory {
        archive_path.push('/');
    }
    let mode = if entry.directory || entry.executable && !declarative {
        0o755
    } else {
        0o644
    };
    let (size, kind) = if entry.directory {
        (0, b'5')
    } else {
        (size, b'0')
    };
    header_block(&archive_path, mode, size, kind)
}

/// Bytes of the ustar name field a path may fill, leaving its NUL.
const MAX_NAME_BYTES: usize = 99;

/// One ustar header: owner 0:0, mtime 0, `kind` `0` (file) or `5` (directory).
pub(crate) fn header_block(
    path: &str,
    mode: u64,
    size: u64,
    kind: u8,
) -> Result<[u8; BLOCK], RegistryError> {
    let mut header = [0_u8; BLOCK];
    let (name, prefix) = split_tar_path(path)?;
    put_text(&mut header, 0, 100, name)?;
    put_octal(&mut header, 100, 8, mode)?;
    put_octal(&mut header, 108, 8, 0)?;
    put_octal(&mut header, 116, 8, 0)?;
    put_octal(&mut header, 124, 12, size)?;
    put_octal(&mut header, 136, 12, 0)?;
    header[148..156].fill(0x20);
    header[156] = kind;
    put_text(&mut header, 257, 6, "ustar\0")?;
    put_text(&mut header, 263, 2, "00")?;
    put_text(&mut header, 345, 155, prefix)?;
    let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
    put_text(&mut header, 148, 6, &format!("{checksum:06o}"))?;
    header[154] = 0;
    header[155] = 0x20;
    Ok(header)
}

/// The ustar `(name, prefix)` for `value`. The name field always keeps a
/// terminating NUL (at most [`MAX_NAME_BYTES`]), which is what the archive
/// readers ([`crate::theme_verify::read_tar`]) require; a longer path is split
/// at a `/` into the 155-byte prefix field, or refused here at pack time.
fn split_tar_path(value: &str) -> Result<(&str, &str), RegistryError> {
    if value.len() <= MAX_NAME_BYTES {
        return Ok((value, ""));
    }
    for (index, _) in value.match_indices('/').rev() {
        if index > 0 && index <= 155 && value.len() - index - 1 <= MAX_NAME_BYTES {
            return Ok((&value[index + 1..], &value[..index]));
        }
    }
    Err(bad(format!(
        "path cannot be represented safely in a portable TAR header (at most 99 bytes after a `/` that leaves at most 155 before it): {value}"
    )))
}

fn put_text(
    buffer: &mut [u8],
    offset: usize,
    length: usize,
    value: &str,
) -> Result<(), RegistryError> {
    let bytes = value.as_bytes();
    if bytes.len() > length {
        return Err(bad(format!("TAR field is too long: {value}")));
    }
    buffer[offset..offset + bytes.len()].copy_from_slice(bytes);
    Ok(())
}

fn put_octal(
    buffer: &mut [u8],
    offset: usize,
    length: usize,
    value: u64,
) -> Result<(), RegistryError> {
    let rendered = format!("{value:0width$o}", width = length - 1);
    if rendered.len() >= length {
        return Err(bad(format!("value is too large for TAR header: {value}")));
    }
    put_text(buffer, offset, length - 1, &rendered)?;
    buffer[offset + length - 1] = 0;
    Ok(())
}

fn verify_entry(snapshot: &Snapshot, entry: &Entry) -> Result<(), RegistryError> {
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

fn verify_snapshot(snapshot: &Snapshot) -> Result<(), RegistryError> {
    if scan::current_identity(&snapshot.root)? != snapshot.root_identity {
        return Err(bad("staging root changed while packaging"));
    }
    let after = scan::collect(&snapshot.root)?;
    if after.entries != snapshot.entries {
        return Err(bad("staging tree changed while packaging"));
    }
    Ok(())
}

#[cfg(unix)]
fn open_source(path: &Path) -> Result<File, RegistryError> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(io_error)?;
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(bad("package source changed to a non-regular file"));
    }
    Ok(file)
}
#[cfg(not(unix))]
fn open_source(path: &Path) -> Result<File, RegistryError> {
    File::open(path).map_err(io_error)
}

fn changed(entry: &Entry) -> RegistryError {
    bad(format!(
        "file changed while packaging: {}",
        entry.relative.display()
    ))
}
fn bad(message: impl Into<String>) -> RegistryError {
    RegistryError::single(message)
}
fn io_error(error: io::Error) -> RegistryError {
    bad(format!("package archive I/O failed: {error}"))
}

struct DigestWriter {
    file: File,
    hash: Sha256,
    size: u64,
    limit: u64,
}
impl DigestWriter {
    fn new(file: File, limit: u64) -> Self {
        Self {
            file,
            hash: Sha256::new(),
            size: 0,
            limit,
        }
    }
    fn finish(self) -> BuiltArchive {
        BuiltArchive {
            sha256: crate::digest::hex_lower(&self.hash.finalize()),
            size: self.size,
        }
    }
}
impl Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .size
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("package archive size overflow"))?;
        if next > self.limit {
            return Err(io::Error::other(format!(
                "package archive exceeds {} compressed bytes",
                self.limit
            )));
        }
        self.file.write_all(bytes)?;
        self.hash.update(bytes);
        self.size = next;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tar(path: &str) -> Result<Vec<u8>, RegistryError> {
        let mut bytes = header_block(path, 0o644, 2, b'0')?.to_vec();
        bytes.extend(b"hi");
        bytes.extend([0; 510]);
        bytes.extend([0; 1024]);
        Ok(bytes)
    }

    #[test]
    fn every_name_the_writer_packs_reads_back() {
        let long_name = "n".repeat(99);
        let at_limit = format!("{}/{}", "d".repeat(155), "n".repeat(99));
        for path in [
            long_name.clone(),
            format!("dir/{}", "n".repeat(96)),
            format!("dir/{}", "n".repeat(97)),
            format!("{}/{long_name}", "d".repeat(40)),
            at_limit,
        ] {
            let files = crate::theme_verify::read_tar(&tar(&path).unwrap(), 1, true)
                .unwrap_or_else(|error| panic!("{} bytes: {error}", path.len()));
            assert_eq!(files.get(&path).map(Vec::as_slice), Some(&b"hi"[..]));
        }
    }

    #[test]
    fn a_name_the_reader_could_not_read_is_refused_at_pack_time() {
        for path in [
            "n".repeat(100),
            format!("dir/{}", "n".repeat(100)),
            format!("{}/{}", "d".repeat(156), "n".repeat(10)),
        ] {
            let error = tar(&path).unwrap_err().to_string();
            assert!(error.contains("portable TAR header"), "{error}");
        }
    }
}
