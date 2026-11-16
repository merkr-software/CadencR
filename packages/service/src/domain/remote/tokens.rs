//! Device-token minting, hashing, and verification.
//!
//! Tokens are 256-bit CSPRNG values. We store only `hex(sha256(pepper || raw))`
//! (the pepper lives on disk, outside the DB), so a database leak alone yields
//! no usable token. High-entropy randoms don't need a slow KDF — a keyed hash
//! is sufficient.

use super::repo;
use crate::shared::security::constant_time_str_eq;
use base64::Engine;
use rand::TryRng;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::fmt::Write;

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
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
    }
    hex
}

/// Resolve a presented raw token to an active device id, or `None`. The lookup
/// is by indexed hash; the constant-time re-compare is defense-in-depth.
pub async fn verify_device_token(pool: &SqlitePool, pepper: &[u8], presented: &str) -> Option<i64> {
    let hash = hash_token(pepper, presented);
    match repo::find_active_device_hash(pool, &hash).await {
        Ok(Some((id, stored))) if constant_time_str_eq(&stored, &hash) => Some(id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

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

    #[tokio::test]
    async fn device_tokens_remain_valid_until_revoked() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        sqlx::query(
            "CREATE TABLE remote_devices (
                id INTEGER PRIMARY KEY,
                token_hash TEXT NOT NULL UNIQUE,
                label TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_seen_at TEXT,
                revoked_at TEXT
            )",
        )
        .execute(&pool)
        .await
        .expect("create remote device table");

        let pepper = b"pepper";
        let token = "long-lived-token";
        sqlx::query(
            "INSERT INTO remote_devices (token_hash, label, created_at) \
             VALUES (?, 'long-lived', datetime('now', '-365 days'))",
        )
        .bind(hash_token(pepper, token))
        .execute(&pool)
        .await
        .expect("insert old device token");

        assert!(verify_device_token(&pool, pepper, token).await.is_some());
        let listed = repo::list_active_devices(&pool)
            .await
            .expect("list active devices");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label.as_deref(), Some("long-lived"));
    }
}
