//! Device-token minting, hashing, and verification.
//!
//! Tokens are 256-bit CSPRNG values. We store only `hex(sha256(pepper || raw))`
//! (the pepper lives on disk, outside the DB), so a database leak alone yields
//! no usable token. High-entropy randoms don't need a slow KDF — a keyed hash
//! is sufficient.

use base64::Engine;
use rand::TryRng;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;

use super::repo;

/// Mint a fresh 256-bit device token (URL-safe base64, no padding — safe in a
/// `Sec-WebSocket-Protocol` token and a URL).
pub fn mint_raw_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS random source should be available");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `hex(sha256(pepper || raw))`.
pub fn hash_token(pepper: &[u8], raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(pepper);
    hasher.update(raw.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hashes_equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// Resolve a presented raw token to an active device id, or `None`. The lookup
/// is by indexed hash; the constant-time re-compare is defense-in-depth.
pub async fn verify_device_token(pool: &SqlitePool, pepper: &[u8], presented: &str) -> Option<i64> {
    let hash = hash_token(pepper, presented);
    match repo::find_active_device_hash(pool, &hash).await {
        Ok(Some((id, stored))) if hashes_equal(&stored, &hash) => Some(id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_pepper_sensitive() {
        let raw = mint_raw_token();
        assert_eq!(hash_token(b"pepper-a", &raw), hash_token(b"pepper-a", &raw));
        assert_ne!(hash_token(b"pepper-a", &raw), hash_token(b"pepper-b", &raw));
    }

    #[test]
    fn minted_tokens_are_distinct_and_long() {
        let a = mint_raw_token();
        let b = mint_raw_token();
        assert_ne!(a, b);
        // 32 bytes base64url-no-pad => 43 chars.
        assert_eq!(a.len(), 43);
    }
}
