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
/// The task finishes even if the caller disconnects. A retry for an already
/// revoked device also clears any stale authentication state.
pub async fn revoke_device(state: &AppState, id: i64) -> Result<bool, AppError> {
    let pool = state.write_pool.clone();
    let remote = state.remote.clone();
    tokio::spawn(async move {
        let revoked = repo::mark_revoked(&pool, id).await?;
        if revoked || repo::is_revoked(&pool, id).await? {
            remote.token_cache().evict_device(id);
            remote.live().cancel_device(id);
        }
        if revoked {
            repo::record_audit(&pool, "revoke", Some(id), None).await?;
        }
        Ok(revoked)
    })
    .await
    .map_err(|error| AppError::internal(format!("device revocation task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::remote::tokens::{hash_token, mint_raw_token, verify_device_token};

    async fn paired_device() -> (AppState, i64, String) {
        let pool = repo::remote_devices_test_pool().await;
        sqlx::query(
            "CREATE TABLE remote_audit (event TEXT NOT NULL, device_id INTEGER, detail TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let token = mint_raw_token();
        let id = repo::insert_device(&pool, &hash_token(TEST_PEPPER, &token), "phone")
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        assert_eq!(
            verify_device_token(
                state.remote.token_cache(),
                &state.read_pool,
                TEST_PEPPER,
                &token
            )
            .await,
            Some(id),
            "the token is verified and cached"
        );
        (state, id, token)
    }

    const TEST_PEPPER: &[u8] = b"revocation-test-pepper";

    #[tokio::test]
    async fn a_revoked_device_is_refused_at_once_and_disconnected() {
        let (state, id, token) = paired_device().await;
        let (socket, _) = state.remote.live().register(id);

        assert!(revoke_device(&state, id).await.unwrap());

        assert_eq!(
            verify_device_token(
                state.remote.token_cache(),
                &state.read_pool,
                TEST_PEPPER,
                &token
            )
            .await,
            None
        );
        assert!(socket.token.is_cancelled());
        assert!(!revoke_device(&state, id).await.unwrap(), "already revoked");
    }

    #[tokio::test]
    async fn a_dropped_revocation_request_still_invalidates_the_token_and_socket() {
        let (state, id, token) = paired_device().await;
        let (socket, _) = state.remote.live().register(id);
        let connection = state.write_pool.acquire().await.unwrap();
        {
            let mut request = std::pin::pin!(revoke_device(&state, id));
            assert!(futures::poll!(request.as_mut()).is_pending());
        }
        drop(connection);

        tokio::time::timeout(std::time::Duration::from_secs(5), socket.token.cancelled())
            .await
            .expect("the task completes revocation after the request is gone");
        assert_eq!(
            verify_device_token(
                state.remote.token_cache(),
                &state.read_pool,
                TEST_PEPPER,
                &token
            )
            .await,
            None
        );
    }
}
