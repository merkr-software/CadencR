use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;

use flate2::{Compression, GzBuilder};
use sha2::{Digest as _, Sha256};

use super::output::CreatedOutput;
use super::scan::{self, Entry, Snapshot};
use super::BuiltArchive;
use crate::RegistryError;

const BLOCK: usize = 512;
const MAX_COMPRESSED_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn archive(snapshot: &Snapshot, output: &Path) -> Result<BuiltArchive, RegistryError> {
    reject_output_location(snapshot, output)?;
    archive_with(snapshot, output, write_owned)
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

fn reject_output_location(snapshot: &Snapshot, output: &Path) -> Result<(), RegistryError> {
    let parent = output
        .parent()
        .ok_or_else(|| bad("archive output must have a parent directory"))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|error| bad(format!("cannot resolve archive output directory: {error}")))?;
    if canonical_parent.starts_with(&snapshot.root) {
        return Err(bad("output must not be inside staging directory"));
    }
    Ok(())
}

fn write_owned(snapshot: &Snapshot, file: File) -> Result<BuiltArchive, RegistryError> {
    let digest = DigestWriter::new(file);
    let mut gzip = GzBuilder::new()
        .mtime(0)
        .operating_system(19)
        .write(digest, Compression::best());
    for entry in &snapshot.entries {
        append(snapshot, entry, &mut gzip)?;
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
) -> Result<(), RegistryError> {
    verify_entry(snapshot, entry)?;
    output
        .write_all(&tar_header(entry, entry.identity.len)?)
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

fn tar_header(entry: &Entry, size: u64) -> Result<[u8; BLOCK], RegistryError> {
    let mut header = [0_u8; BLOCK];
    let mut archive_path = entry.relative.to_string_lossy().replace('\\', "/");
    if entry.directory {
        archive_path.push('/');
    }
    let (name, prefix) = split_tar_path(&archive_path)?;
    put_text(&mut header, 0, 100, name)?;
    put_octal(
        &mut header,
        100,
        8,
        if entry.directory || entry.executable {
            0o755
        } else {
            0o644
        },
    )?;
    put_octal(&mut header, 108, 8, 0)?;
    put_octal(&mut header, 116, 8, 0)?;
    put_octal(&mut header, 124, 12, if entry.directory { 0 } else { size })?;
    put_octal(&mut header, 136, 12, 0)?;
    header[148..156].fill(0x20);
    header[156] = if entry.directory { b'5' } else { b'0' };
    put_text(&mut header, 257, 6, "ustar\0")?;
    put_text(&mut header, 263, 2, "00")?;
    put_text(&mut header, 345, 155, prefix)?;
    let checksum = header.iter().map(|byte| u64::from(*byte)).sum::<u64>();
    put_text(&mut header, 148, 6, &format!("{checksum:06o}"))?;
    header[154] = 0;
    header[155] = 0x20;
    Ok(header)
}

fn split_tar_path(value: &str) -> Result<(&str, &str), RegistryError> {
    if value.len() <= 100 {
        return Ok((value, ""));
    }
    for (index, _) in value.match_indices('/').rev() {
        if index > 0 && index <= 155 && value.len() - index - 1 <= 100 {
            return Ok((&value[index + 1..], &value[..index]));
        }
    }
    Err(bad(format!(
        "path cannot be represented safely in a portable TAR header: {value}"
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
        let next = self
            .size
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("package archive size overflow"))?;
        if next > MAX_COMPRESSED_BYTES {
            return Err(io::Error::other(format!(
                "package archive exceeds {MAX_COMPRESSED_BYTES} compressed bytes"
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
