//! Bounded in-memory gunzip of one downloaded or packed archive.
use std::io::Read as _;

/// Why [`gunzip_bounded`] refused.
#[derive(Debug)]
pub(crate) enum GunzipError {
    /// Not a gzip stream (or a corrupt one).
    Invalid(std::io::Error),
    /// More than the limit decoded, or bytes after the first gzip member.
    OversizedOrTrailing,
}

/// The decoded bytes of `compressed`, a single gzip member of at most
/// `limit` decoded bytes with nothing after it.
pub(crate) fn gunzip_bounded(compressed: &[u8], limit: u64) -> Result<Vec<u8>, GunzipError> {
    let mut decoder = flate2::bufread::GzDecoder::new(compressed);
    let mut decoded = Vec::new();
    (&mut decoder)
        .take(limit.saturating_add(1))
        .read_to_end(&mut decoded)
        .map_err(GunzipError::Invalid)?;
    if decoded.len() as u64 > limit || !decoder.get_ref().is_empty() {
        return Err(GunzipError::OversizedOrTrailing);
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn decodes_one_bounded_member_only() {
        assert_eq!(gunzip_bounded(&gzip(b"abc"), 3).unwrap(), b"abc");
        assert!(matches!(
            gunzip_bounded(&gzip(b"abcd"), 3),
            Err(GunzipError::OversizedOrTrailing)
        ));
        let mut trailing = gzip(b"abc");
        trailing.extend(gzip(b""));
        assert!(matches!(
            gunzip_bounded(&trailing, 3),
            Err(GunzipError::OversizedOrTrailing)
        ));
        assert!(matches!(
            gunzip_bounded(b"not gzip", 3),
            Err(GunzipError::Invalid(_))
        ));
    }
}
