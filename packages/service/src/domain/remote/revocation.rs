//! The one way to revoke a remote device.
//!
//! Remote requests authenticate through an in-memory token cache
//! ([`super::tokens::DeviceTokenCache`]) that keeps a verified token for
//! minutes. Revoking only the row would leave the device authenticated until
//! that entry expires, and its open sockets running. Every revocation goes
//! through [`revoke_device`], the only caller of the row update.

use crate::app_state::AppState;
use crate::error::AppError;

use super::repo;

/// Revoke device `id`: its row, then its cached token (so a reconnect is
/// refused), then its live sockets. Returns whether an active device was
/// revoked.
///
/// The cache is evicted only once the row is revoked: a lookup that read the
/// row before then cannot cache it afterwards (the eviction bumps the cache's
/// generation), and one that reads it after finds it revoked.
pub async fn revoke_device(state: &AppState, id: i64) -> Result<bool, AppError> {
    if !repo::mark_revoked(&state.write_pool, id).await? {
        return Ok(false);
    }
    state.remote.token_cache().evict_device(id);
    state.remote.live().cancel_device(id);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::remote::tokens::{hash_token, mint_raw_token, verify_device_token};

    #[tokio::test]
    async fn a_revoked_device_is_refused_at_once_and_disconnected() {
        let pool = repo::remote_devices_test_pool().await;
        let pepper = b"revocation-test-pepper";
        let token = mint_raw_token();
        let id = repo::insert_device(&pool, &hash_token(pepper, &token), "phone")
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());
        let cache = state.remote.token_cache();
        assert_eq!(
            verify_device_token(cache, &pool, pepper, &token).await,
            Some(id),
            "the token is verified and cached"
        );
        let (socket, _) = state.remote.live().register(id);

        assert!(revoke_device(&state, id).await.unwrap());

        assert_eq!(
            verify_device_token(cache, &pool, pepper, &token).await,
            None
        );
        assert!(socket.token.is_cancelled());
        assert!(!revoke_device(&state, id).await.unwrap(), "already revoked");
    }
}
