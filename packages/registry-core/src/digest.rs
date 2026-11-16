//! SHA-256 digests as the registry writes them: lowercase hex.
use sha2::{Digest as _, Sha256};

/// The lowercase-hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

/// `bytes` as lowercase hex.
pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Exactly `len` lowercase hex digits (a SHA-256 is 64, a git commit 40).
pub(crate) fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// A lowercase-hex SHA-256.
pub(crate) fn is_lower_sha256(value: &str) -> bool {
    is_lower_hex(value, 64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_are_lowercase_hex() {
        let digest = sha256_hex(b"");
        assert_eq!(
            digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(is_lower_sha256(&digest));
        assert!(!is_lower_sha256(&digest.to_uppercase()));
        assert!(!is_lower_sha256(&digest[1..]));
        assert!(!is_lower_sha256(&format!("{}g", &digest[1..])));
        assert!(is_lower_hex(&"a".repeat(40), 40));
        assert_eq!(hex_lower(&[0, 0xab]), "00ab");
    }
}
