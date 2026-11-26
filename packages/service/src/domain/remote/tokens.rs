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
use std::collections::HashMap;
use std::fmt::Write;
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, Instant};

const MAX_CACHED_DEVICE_TOKENS: usize = 1024;
const TOKEN_CACHE_TTL: Duration = Duration::from_secs(5 * 60);

struct CachedToken {
    device_id: i64,
    expires_at: Instant,
}

#[derive(Default)]
struct TokenCacheState {
    eviction_gen: u64,
    entries: HashMap<String, CachedToken>,
}

/// Small in-memory `token_hash -> device_id` cache so hot remote API requests
/// do not acquire SQLite's `read_pool` on every authenticated call.
/// Revocations bump `eviction_gen` and evict synchronously so an in-flight
/// lookup can never re-insert a token revoked while SQLite was awaited.
#[derive(Default)]
pub struct DeviceTokenCache {
    state: RwLock<TokenCacheState>,
}

impl DeviceTokenCache {
    fn lookup_or_gen(&self, token_hash: &str, now: Instant) -> Result<i64, u64> {
        let state = self.state.read().unwrap_or_else(PoisonError::into_inner);
        if let Some(cached) = state.entries.get(token_hash) {
            if cached.expires_at > now {
                return Ok(cached.device_id);
            }
        }
        Err(state.eviction_gen)
    }

    fn insert_if_gen(
        &self,
        token_hash: String,
        device_id: i64,
        expected_gen: u64,
        now: Instant,
    ) -> bool {
        let mut state = self.state.write().unwrap_or_else(PoisonError::into_inner);
        if state.eviction_gen != expected_gen {
            return false;
        }
        if state.entries.len() >= MAX_CACHED_DEVICE_TOKENS
            && !state.entries.contains_key(&token_hash)
        {
            state.entries.retain(|_, cached| cached.expires_at > now);
            if state.entries.len() >= MAX_CACHED_DEVICE_TOKENS {
                state.entries.clear();
            }
        }
        state.entries.insert(
            token_hash,
            CachedToken {
                device_id,
                expires_at: now + TOKEN_CACHE_TTL,
            },
        );
        true
    }

    pub fn evict_device(&self, device_id: i64) {
        let mut state = self.state.write().unwrap_or_else(PoisonError::into_inner);
        state.eviction_gen = state.eviction_gen.wrapping_add(1);
        state
            .entries
            .retain(|_, cached| cached.device_id != device_id);
    }
}

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

/// Resolve a presented raw token to an active device id, or `None`. Checks the
/// in-memory cache first; on miss, snapshots the eviction generation before
/// querying SQLite (with constant-time re-compare as defense-in-depth) and
/// only caches the result if no eviction ran meanwhile.
pub async fn verify_device_token(
    cache: &DeviceTokenCache,
    pool: &SqlitePool,
    pepper: &[u8],
    presented: &str,
) -> Option<i64> {
    let hash = hash_token(pepper, presented);
    // Re-read if revocation raced this lookup. The generation covers every
    // device, so an unrelated revocation can also invalidate the first read.
    for _ in 0..2 {
        let generation = match cache.lookup_or_gen(&hash, Instant::now()) {
            Ok(device_id) => return Some(device_id),
            Err(generation) => generation,
        };
        match repo::find_active_device_hash(pool, &hash).await {
            Ok(Some((id, stored))) if constant_time_str_eq(&stored, &hash) => {
                if cache.insert_if_gen(hash.clone(), id, generation, Instant::now()) {
                    return Some(id);
                }
            }
            _ => return None,
        }
    }
    None
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

    #[tokio::test]
    async fn device_tokens_remain_valid_until_revoked() {
        let pool = repo::remote_devices_test_pool().await;

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

        let cache = DeviceTokenCache::default();
        assert!(verify_device_token(&cache, &pool, pepper, token)
            .await
            .is_some());
        let listed = repo::list_active_devices(&pool)
            .await
            .expect("list active devices");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label.as_deref(), Some("long-lived"));
    }

    #[tokio::test]
    async fn token_cache_serves_hits_without_db_and_evicts_synchronously() {
        let pool = repo::remote_devices_test_pool().await;

        let cache = DeviceTokenCache::default();
        let pepper = b"cache-unit-test-pepper";
        let token = mint_raw_token();
        let id = repo::insert_device(&pool, &hash_token(pepper, &token), "phone")
            .await
            .unwrap();

        // Miss populates cache.
        assert_eq!(
            verify_device_token(&cache, &pool, pepper, &token).await,
            Some(id)
        );
        // Closing the pool proves the next lookup is served purely from cache.
        pool.close().await;
        assert_eq!(
            verify_device_token(&cache, &pool, pepper, &token).await,
            Some(id)
        );

        // Synchronous eviction immediately invalidates the cached token.
        cache.evict_device(id);
        assert_eq!(
            verify_device_token(&cache, &pool, pepper, &token).await,
            None
        );
    }

    #[test]
    fn concurrent_eviction_prevents_resurrecting_revoked_token_in_cache() {
        let cache = DeviceTokenCache::default();
        let hash = hash_token(b"toctou-pepper", "revoked-in-flight");
        let now = Instant::now();

        // 1. Cache miss snapshots eviction_gen before the SQLite lookup runs.
        let generation = cache.lookup_or_gen(&hash, now).unwrap_err();

        // 2. Device is revoked while SQLite is being awaited.
        cache.evict_device(42);

        // 3. Stale DB result must NOT be inserted because eviction_gen advanced.
        assert!(
            !cache.insert_if_gen(hash.clone(), 42, generation, now),
            "stale lookup must not populate cache after concurrent eviction"
        );
        assert!(
            cache.lookup_or_gen(&hash, now).is_err(),
            "revoked token must not be present in cache"
        );

        // 4. Fresh lookups with the new generation still cache normally and expire after TTL.
        let fresh_gen = cache.lookup_or_gen(&hash, now).unwrap_err();
        assert!(cache.insert_if_gen(hash.clone(), 99, fresh_gen, now));
        assert_eq!(cache.lookup_or_gen(&hash, now), Ok(99));
        assert!(
            cache.lookup_or_gen(&hash, now + TOKEN_CACHE_TTL).is_err(),
            "expired cache entry must be ignored"
        );
    }
}
