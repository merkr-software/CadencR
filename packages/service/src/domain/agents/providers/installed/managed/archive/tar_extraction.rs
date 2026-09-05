//! Raw TAR iteration keeps extension allocations behind the host's limits.

use std::io::{self, Read};
use std::path::Path;

use super::{
    create_directory, safe_file_mode, validate_mode, write_file, ArtifactError, ArtifactErrorCode,
    ExtractionBudget, MAX_ARCHIVE_ENTRIES, MAX_UNCOMPRESSED_BYTES,
};

mod metadata;
use metadata::PendingMetadata;

// Include headers, padding and metadata in the decompressor's own budget, not
// just extracted files. TAR's final padding is included in this allowance.
const MAX_TAR_STREAM_BYTES: u64 = MAX_UNCOMPRESSED_BYTES + MAX_ARCHIVE_ENTRIES as u64 * 1024 + 1024;

pub(super) fn extract_tar<R: Read>(
    reader: R,
    root: &Path,
    budget: &mut ExtractionBudget,
) -> Result<(), ArtifactError> {
    extract_with_limit(reader, root, budget, MAX_TAR_STREAM_BYTES)
}

fn extract_with_limit<R: Read>(
    reader: R,
    root: &Path,
    budget: &mut ExtractionBudget,
    limit: u64,
) -> Result<(), ArtifactError> {
    let mut reader = reader.take(limit + 1);
    let result = extract_entries(&mut reader, root, budget).and_then(|()| {
        // The TAR parser stops at its zero terminator. Drain remaining padding
        // through the same cap so an ignored compressed tail cannot evade it.
        io::copy(&mut reader, &mut io::sink())
            .map(|_| ())
            .map_err(ArtifactError::unsafe_archive)
    });
    if reader.limit() == 0 {
        return Err(ArtifactError::new(
            ArtifactErrorCode::ArchiveTooLarge,
            format!("TAR stream exceeds {limit} decompressed bytes including metadata and padding"),
        ));
    }
    result
}

fn extract_entries<R: Read>(
    reader: R,
    root: &Path,
    budget: &mut ExtractionBudget,
) -> Result<(), ArtifactError> {
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(ArtifactError::unsafe_archive)?
        .raw(true);
    let mut metadata = PendingMetadata::default();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err(ArtifactError::new(
                ArtifactErrorCode::TooManyEntries,
                format!("TAR exceeds {MAX_ARCHIVE_ENTRIES} headers including metadata"),
            ));
        }
        let mut entry = entry.map_err(ArtifactError::unsafe_archive)?;
        if metadata.consume_extension(&mut entry)? {
            continue;
        }
        extract_entry(&mut entry, root, budget, &mut metadata)?;
    }
    metadata.finish()
}

fn extract_entry<R: Read>(
    entry: &mut tar::Entry<'_, R>,
    root: &Path,
    budget: &mut ExtractionBudget,
    metadata: &mut PendingMetadata,
) -> Result<(), ArtifactError> {
    let kind = entry.header().entry_type();
    if !kind.is_file() && !kind.is_dir() {
        return Err(ArtifactError::unsafe_archive(
            "archive links, sparse files, global metadata, and special entries are forbidden",
        ));
    }
    let size = entry
        .header()
        .size()
        .map_err(ArtifactError::unsafe_archive)?;
    if kind.is_dir() && size != 0 {
        return Err(ArtifactError::unsafe_archive(
            "TAR directory entries must have an empty body",
        ));
    }
    let relative = metadata.resolve(entry.header(), size)?;
    if relative.as_os_str().is_empty() {
        if !kind.is_dir() {
            return Err(ArtifactError::unsafe_archive(
                "TAR file path must not be empty",
            ));
        }
        return Ok(());
    }
    let mode = entry
        .header()
        .mode()
        .map_err(ArtifactError::unsafe_archive)?;
    validate_mode(Some(mode), kind.is_dir(), &relative)?;
    budget.register(&relative, size, kind.is_file())?;
    if kind.is_dir() {
        create_directory(root, &relative)
    } else {
        write_file(root, &relative, entry, size, safe_file_mode(Some(mode)))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::{Cursor, Write as _};
    use std::rc::Rc;

    use super::*;

    fn header(path: &str, kind: tar::EntryType, size: u64) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        header.set_path(path).unwrap();
        header.set_entry_type(kind);
        header.set_mode(0o755);
        header.set_size(size);
        header.set_cksum();
        header
    }

    fn extract(bytes: &[u8], limit: u64) -> Result<ExtractionBudget, ArtifactError> {
        let directory = tempfile::tempdir().unwrap();
        let mut budget = ExtractionBudget::default();
        extract_with_limit(Cursor::new(bytes), directory.path(), &mut budget, limit)?;
        Ok(budget)
    }

    #[test]
    fn metadata_is_rejected_from_header_before_reading_large_body() {
        struct CountingReader {
            bytes: Cursor<Vec<u8>>,
            reads: Rc<Cell<usize>>,
        }
        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let read = self.bytes.read(buffer)?;
                self.reads.set(self.reads.get() + read);
                Ok(read)
            }
        }
        for kind in [tar::EntryType::GNULongName, tar::EntryType::XHeader] {
            let bytes = header("metadata", kind, 1 << 40).as_bytes().to_vec();
            let reads = Rc::new(Cell::new(0));
            let directory = tempfile::tempdir().unwrap();
            let error = extract_with_limit(
                CountingReader {
                    bytes: Cursor::new(bytes),
                    reads: Rc::clone(&reads),
                },
                directory.path(),
                &mut ExtractionBudget::default(),
                4096,
            )
            .unwrap_err();
            assert_eq!(error.code, ArtifactErrorCode::ArchiveTooLarge);
            assert_eq!(
                reads.get(),
                512,
                "must not read a metadata body before checking its size"
            );
        }
    }

    #[test]
    fn nonempty_directories_including_root_are_rejected_without_draining_body() {
        for path in ["directory", "."] {
            let bytes = header(path, tar::EntryType::Directory, 1 << 40);
            let error = extract(bytes.as_bytes(), 1024).err().unwrap();
            assert_eq!(error.code, ArtifactErrorCode::UnsafeArchive);
            assert!(error.message.contains("empty body"));
        }
    }

    #[test]
    fn total_decompressed_budget_includes_file_padding_and_ignored_tail() {
        let mut archive = tar::Builder::new(Vec::new());
        archive
            .append(&header("agent", tar::EntryType::Regular, 1), &b"x"[..])
            .unwrap();
        let bytes = archive.into_inner().unwrap();
        assert!(extract(&bytes, bytes.len() as u64).is_ok());
        let error = extract(&bytes, 700).err().unwrap();
        assert_eq!(error.code, ArtifactErrorCode::ArchiveTooLarge);

        // Even a valid empty archive followed by highly compressible padding
        // is bounded after the parser stops at the first zero header.
        let error = extract(&vec![0; 8192], 1024).err().unwrap();
        assert_eq!(error.code, ArtifactErrorCode::ArchiveTooLarge);
    }

    #[test]
    fn compressed_tail_is_limited_before_tar_parser_can_ignore_it() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(&vec![0; 16 * 1024]).unwrap();
        let compressed = encoder.finish().unwrap();
        assert!(compressed.len() < 1024);
        let directory = tempfile::tempdir().unwrap();
        let error = extract_with_limit(
            flate2::read::GzDecoder::new(Cursor::new(compressed)),
            directory.path(),
            &mut ExtractionBudget::default(),
            1024,
        )
        .unwrap_err();
        assert_eq!(error.code, ArtifactErrorCode::ArchiveTooLarge);
    }

    #[test]
    fn skipped_root_headers_still_consume_entry_budget() {
        let header = header(".", tar::EntryType::Directory, 0);
        let bytes = header.as_bytes().repeat(MAX_ARCHIVE_ENTRIES + 1);
        let error = extract(&bytes, bytes.len() as u64 + 1024).err().unwrap();
        assert_eq!(error.code, ArtifactErrorCode::TooManyEntries);
    }

    #[test]
    fn bounded_gnu_longname_and_local_pax_paths_remain_supported() {
        let directory = tempfile::tempdir().unwrap();
        let long_path = format!("assets/{}/agent", "a".repeat(110));
        let mut archive = tar::Builder::new(Vec::new());
        archive
            .append_data(
                &mut header("short", tar::EntryType::Regular, 1),
                &long_path,
                &b"x"[..],
            )
            .unwrap();
        archive
            .append_pax_extensions([
                ("path", b"assets/pax-agent".as_slice()),
                ("mtime", b"1.5".as_slice()),
            ])
            .unwrap();
        archive
            .append(&header("short", tar::EntryType::Regular, 1), &b"y"[..])
            .unwrap();
        let bytes = archive.into_inner().unwrap();
        let mut budget = ExtractionBudget::default();
        extract_with_limit(Cursor::new(bytes), directory.path(), &mut budget, 16384).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join(long_path)).unwrap(),
            b"x"
        );
        assert_eq!(
            std::fs::read(directory.path().join("assets/pax-agent")).unwrap(),
            b"y"
        );
        assert_eq!(budget.file_count, 2);
    }

    #[test]
    fn pax_path_cannot_escape_and_pax_size_cannot_desynchronize_raw_parser() {
        for (key, value) in [
            ("path", "../escape"),
            ("size", "9000"),
            ("GNU.sparse.size", "1"),
        ] {
            let mut archive = tar::Builder::new(Vec::new());
            archive
                .append_pax_extensions([(key, value.as_bytes())])
                .unwrap();
            archive
                .append(&header("agent", tar::EntryType::Regular, 1), &b"x"[..])
                .unwrap();
            let bytes = archive.into_inner().unwrap();
            assert!(extract(&bytes, 16384).is_err(), "{key}");
        }
    }
}
