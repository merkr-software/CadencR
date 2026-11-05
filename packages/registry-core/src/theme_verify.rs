//! Bounded inspection of the normalized declarative archive, without extraction.
use crate::gzip::{gunzip_bounded, GunzipError};
use crate::RegistryError;
use cadencr_plugin_core::theme::{parse_distributed_document, validate_distributed_asset};
use std::{collections::BTreeMap, path::Path};
const LIMIT: u64 = 32 * 1024 * 1024;

pub fn verify_theme_archive(path: &Path) -> Result<(), RegistryError> {
    read_theme_archive(path).map(|_| ())
}

pub fn read_theme_archive(path: &Path) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    let compressed = crate::safe_io::read_bounded_regular(path, LIMIT)
        .map_err(|e| RegistryError::single(format!("cannot read theme archive: {e}")))?;
    read_theme_archive_bytes(&compressed)
}

/// Inspect one captured archive snapshot; callers can bind these exact bytes to a signed digest.
pub fn read_theme_archive_bytes(
    compressed: &[u8],
) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    if compressed.len() as u64 > LIMIT {
        return Err(invalid());
    }
    let decoded = gunzip_bounded(compressed, LIMIT).map_err(|error| match error {
        GunzipError::Invalid(e) => RegistryError::single(format!("invalid theme gzip: {e}")),
        GunzipError::OversizedOrTrailing => invalid(),
    })?;
    let files = read_tar(&decoded, 2, false)?;
    let bytes = files.get("theme.json").ok_or_else(invalid)?;
    let document = parse_distributed_document(bytes).map_err(|issues| {
        RegistryError::from_messages(issues.iter().map(|i| i.describe()).collect())
    })?;
    let image = document.chrome.texture.image.as_ref();
    if files.len() != 1 + usize::from(image.is_some()) {
        return Err(invalid());
    }
    if let Some(image) = image {
        let bytes = files.get(&image.asset).ok_or_else(invalid)?;
        validate_distributed_asset(&image.asset, bytes)
            .map_err(|e| RegistryError::single(e.describe()))?;
    }
    Ok(files)
}
fn invalid() -> RegistryError {
    RegistryError::single(
        "theme archive must contain only normalized regular theme.json and declared raster assets",
    )
}
fn octal(bytes: &[u8]) -> Result<usize, RegistryError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| invalid())?
        .trim_matches(['\0', ' ']);
    usize::from_str_radix(text, 8).map_err(|_| invalid())
}
pub(crate) fn read_tar(
    bytes: &[u8],
    max_files: usize,
    nested: bool,
) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    read_tar_with_mode(bytes, max_files, nested, 0o644)
}
/// [`read_tar`] for regular files of exactly `mode` (0755 for a tab backend's executable).
pub(crate) fn read_tar_with_mode(
    bytes: &[u8],
    max_files: usize,
    nested: bool,
    mode: usize,
) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    read_tar_with_modes(bytes, max_files, nested, |_| mode)
}

/// Apply a path-specific mode policy without accepting links or directory entries.
pub(crate) fn read_tar_with_modes(
    bytes: &[u8],
    max_files: usize,
    nested: bool,
    mode: impl Fn(&str) -> usize,
) -> Result<BTreeMap<String, Vec<u8>>, RegistryError> {
    let mut files = BTreeMap::new();
    let mut offset = 0;
    while offset + 512 <= bytes.len() {
        let header = &bytes[offset..offset + 512];
        if header.iter().all(|b| *b == 0) {
            if bytes.len() - offset < 1024 || bytes[offset..].iter().any(|b| *b != 0) {
                return Err(invalid());
            }
            return Ok(files);
        }
        if files.len() >= max_files
            || &header[257..263] != b"ustar\0"
            || &header[263..265] != b"00"
            || header[156] != b'0'
            || octal(&header[108..116])? != 0
            || octal(&header[116..124])? != 0
            || header[157..257].iter().any(|b| *b != 0)
            || !nested && header[345..500].iter().any(|b| *b != 0)
        {
            return Err(invalid());
        }
        let sum: usize = header
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    *b as usize
                }
            })
            .sum();
        if sum != octal(&header[148..156])? {
            return Err(invalid());
        }
        let end = header[..100]
            .iter()
            .position(|b| *b == 0)
            .ok_or_else(invalid)?;
        let name = std::str::from_utf8(&header[..end]).map_err(|_| invalid())?;
        let prefix_end = header[345..500].iter().position(|b| *b == 0).unwrap_or(155);
        let prefix = std::str::from_utf8(&header[345..345 + prefix_end]).map_err(|_| invalid())?;
        let name = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if octal(&header[100..108])? != mode(&name) {
            return Err(invalid());
        }
        if !name.split('/').all(|s| !matches!(s, "" | "." | ".."))
            || name.contains(['\\', '\0'])
            || name.starts_with('/')
        {
            return Err(invalid());
        }
        let size = octal(&header[124..136])?;
        let start = offset + 512;
        let end = start
            .checked_add(size)
            .filter(|e| *e <= bytes.len())
            .ok_or_else(invalid)?;
        if files
            .insert(name.to_owned(), bytes[start..end].to_vec())
            .is_some()
        {
            return Err(invalid());
        }
        offset = end
            .checked_add((512 - size % 512) % 512)
            .ok_or_else(invalid)?;
    }
    Err(invalid())
}
