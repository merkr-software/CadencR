//! Explicitly bounded TAR path metadata; never let `tar` allocate it implicitly.

use std::io::Read;
use std::path::{Path, PathBuf};

use super::super::{normalize_package_path, ArtifactError, ArtifactErrorCode};

const MAX_METADATA_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub(super) struct PendingMetadata {
    long_path: Option<String>,
    pax: Option<PaxMetadata>,
}

#[derive(Default)]
struct PaxMetadata {
    path: Option<String>,
    size: Option<u64>,
}

impl PendingMetadata {
    pub(super) fn consume_extension<R: Read>(
        &mut self,
        entry: &mut tar::Entry<'_, R>,
    ) -> Result<bool, ArtifactError> {
        let kind = entry.header().entry_type();
        if !kind.is_gnu_longname() && !kind.is_pax_local_extensions() {
            return Ok(false);
        }
        let size = entry
            .header()
            .size()
            .map_err(ArtifactError::unsafe_archive)?;
        if size > MAX_METADATA_BYTES {
            return Err(ArtifactError::new(
                ArtifactErrorCode::ArchiveTooLarge,
                format!("TAR metadata exceeds {MAX_METADATA_BYTES} bytes"),
            ));
        }
        let mut bytes = Vec::new();
        entry
            .take(MAX_METADATA_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(ArtifactError::unsafe_archive)?;
        if bytes.len() as u64 != size {
            return Err(ArtifactError::unsafe_archive(
                "TAR metadata body is truncated",
            ));
        }
        if kind.is_gnu_longname() {
            if self.long_path.is_some() {
                return Err(ArtifactError::unsafe_archive(
                    "duplicate TAR longname metadata",
                ));
            }
            let bytes = bytes.strip_suffix(&[0]).unwrap_or(&bytes);
            self.long_path = Some(
                std::str::from_utf8(bytes)
                    .map_err(ArtifactError::unsafe_archive)?
                    .to_owned(),
            );
        } else {
            if self.pax.is_some() {
                return Err(ArtifactError::unsafe_archive(
                    "duplicate TAR local PAX metadata",
                ));
            }
            self.pax = Some(parse_pax(&bytes)?);
        }
        Ok(true)
    }

    pub(super) fn resolve(
        &mut self,
        header: &tar::Header,
        size: u64,
    ) -> Result<PathBuf, ArtifactError> {
        let metadata = std::mem::take(self);
        let pax = metadata.pax.unwrap_or_default();
        // Raw iteration determines physical boundaries from the header. Large
        // PAX size overrides/sparse formats are outside the managed contract;
        // accepting a different size would make parsers disagree about bytes.
        if pax.size.is_some_and(|pax_size| pax_size != size) {
            return Err(ArtifactError::unsafe_archive(
                "PAX size must equal its physical TAR header size",
            ));
        }
        // Match tar's existing resolution when both metadata forms are present.
        let path = metadata.long_path.or(pax.path);
        if let Some(path) = path {
            normalize_package_path(Path::new(&path), "TAR metadata")
        } else {
            normalize_package_path(
                &header.path().map_err(ArtifactError::unsafe_archive)?,
                "archive entry",
            )
        }
    }

    pub(super) fn finish(self) -> Result<(), ArtifactError> {
        if self.long_path.is_some() || self.pax.is_some() {
            return Err(ArtifactError::unsafe_archive(
                "TAR metadata has no following entry",
            ));
        }
        Ok(())
    }
}

fn parse_pax(bytes: &[u8]) -> Result<PaxMetadata, ArtifactError> {
    let mut metadata = PaxMetadata::default();
    for extension in tar::PaxExtensions::new(bytes) {
        let extension = extension.map_err(ArtifactError::unsafe_archive)?;
        let key = extension.key().map_err(ArtifactError::unsafe_archive)?;
        if key.starts_with("GNU.sparse.") {
            return Err(ArtifactError::unsafe_archive(
                "sparse TAR files are forbidden",
            ));
        }
        if key == "path" {
            if metadata.path.is_some() {
                return Err(ArtifactError::unsafe_archive("duplicate PAX path"));
            }
            metadata.path = Some(
                extension
                    .value()
                    .map_err(ArtifactError::unsafe_archive)?
                    .to_owned(),
            );
        } else if key == "size" {
            if metadata.size.is_some() {
                return Err(ArtifactError::unsafe_archive("duplicate PAX size"));
            }
            metadata.size = Some(
                extension
                    .value()
                    .map_err(ArtifactError::unsafe_archive)?
                    .parse::<u64>()
                    .map_err(ArtifactError::unsafe_archive)?,
            );
        }
        // Ownership, timestamps and extended attributes are intentionally not
        // applied by the managed extractor, matching the existing policy.
    }
    Ok(metadata)
}
