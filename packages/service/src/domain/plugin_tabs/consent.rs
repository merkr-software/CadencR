//! Consent: the user accepted a tab's permissions as of one permissions hash.
//!
//! One row per plugin. Recording consent for a new hash replaces the old one,
//! so a widened manifest is consent-required again until the user re-accepts.

use std::collections::HashMap;

use axum::http::StatusCode;
use cadencr_plugin_core::tab::TabAccessLevel;
use sqlx::SqlitePool;

use crate::error::AppError;

/// The hash the user last consented to, if any.
pub async fn consented_hash(
    pool: &SqlitePool,
    plugin_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(
        sqlx::query_scalar("SELECT permissions_hash FROM plugin_tab_consents WHERE plugin_id = ?")
            .bind(plugin_id)
            .fetch_optional(pool)
            .await?,
    )
}

/// Every recorded consent, keyed by plugin id.
pub async fn consented_all(pool: &SqlitePool) -> Result<HashMap<String, String>, AppError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT plugin_id, permissions_hash FROM plugin_tab_consents")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

/// Refuse a consent for anything but the `current` hash: the user can only
/// agree to what they were shown, and the manifest may have changed since the
/// dialog opened.
pub fn require_current(plugin_id: &str, current: &str, submitted: &str) -> Result<(), AppError> {
    if submitted == current {
        return Ok(());
    }
    Err(AppError::coded(
        StatusCode::CONFLICT,
        "PLUGIN_TAB_CONSENT_STALE",
        format!(
            "custom tab `{plugin_id}` changed its permissions since they were shown; review them again"
        ),
    ))
}

/// Refuse a consent to a tab that runs code outside its page without the
/// user's explicit trust. A listed command is as powerful as native code: the
/// tab picks its arguments, and most programs (`git -c alias.x=!…`, `find
/// -exec`, `ssh -o ProxyCommand`) can run anything from them.
pub fn require_trust(
    plugin_id: &str,
    level: TabAccessLevel,
    trusts_code: bool,
) -> Result<(), AppError> {
    if level == TabAccessLevel::Ui || trusts_code {
        return Ok(());
    }
    Err(AppError::coded(
        StatusCode::UNPROCESSABLE_ENTITY,
        "PLUGIN_TAB_TRUST_REQUIRED",
        format!(
            "custom tab `{plugin_id}` runs code on this computer with your rights; \
             allowing it requires trusting that code (`trusts_code: true`)"
        ),
    ))
}

/// Record consent at `hash`, replacing any older one.
pub async fn record(pool: &SqlitePool, plugin_id: &str, hash: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO plugin_tab_consents (plugin_id, permissions_hash, consented_at) \
         VALUES (?, ?, CURRENT_TIMESTAMP) \
         ON CONFLICT (plugin_id) DO UPDATE SET \
         permissions_hash = excluded.permissions_hash, consented_at = excluded.consented_at",
    )
    .bind(plugin_id)
    .bind(hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record consent at `hash` on behalf of a tab being created, marking its setup
/// as pending until the first availability choice ([`settle_setup`]).
pub async fn record_for_setup(
    pool: &SqlitePool,
    plugin_id: &str,
    hash: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO plugin_tab_consents (plugin_id, permissions_hash, consented_at, setup_pending) \
         VALUES (?, ?, CURRENT_TIMESTAMP, 1) \
         ON CONFLICT (plugin_id) DO UPDATE SET \
         permissions_hash = excluded.permissions_hash, consented_at = excluded.consented_at, \
         setup_pending = 1",
    )
    .bind(plugin_id)
    .bind(hash)
    .execute(pool)
    .await?;
    Ok(())
}

/// Whether the tab's creation consented to exactly `hash` and was interrupted
/// before any availability choice was stored.
pub async fn setup_pending(
    pool: &SqlitePool,
    plugin_id: &str,
    hash: &str,
) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM plugin_tab_consents \
         WHERE plugin_id = ? AND permissions_hash = ? AND setup_pending = 1)",
    )
    .bind(plugin_id)
    .bind(hash)
    .fetch_one(pool)
    .await?)
}

/// An availability choice was stored: creation, if it was pending, is done.
pub async fn settle_setup(pool: &SqlitePool, plugin_id: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE plugin_tab_consents SET setup_pending = 0 WHERE plugin_id = ?")
        .bind(plugin_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::pool;

    #[tokio::test]
    async fn records_only_the_current_hash_and_replaces_older_consent() {
        let pool = pool().await;
        assert_eq!(consented_hash(&pool, "graph").await.unwrap(), None);
        let stale = require_current("graph", "new", "old").unwrap_err();
        assert!(matches!(
            stale,
            AppError::Coded {
                code: "PLUGIN_TAB_CONSENT_STALE",
                ..
            }
        ));
        assert!(require_current("graph", "h1", "h1").is_ok());
        record(&pool, "graph", "h1").await.unwrap();
        record(&pool, "graph", "h2").await.unwrap();
        assert_eq!(
            consented_hash(&pool, "graph").await.unwrap().as_deref(),
            Some("h2")
        );
    }

    #[test]
    fn code_outside_the_page_needs_explicit_trust() {
        assert!(require_trust("graph", TabAccessLevel::Ui, false).is_ok());
        for level in [TabAccessLevel::Commands, TabAccessLevel::Backend] {
            assert!(matches!(
                require_trust("graph", level, false),
                Err(AppError::Coded {
                    code: "PLUGIN_TAB_TRUST_REQUIRED",
                    ..
                })
            ));
            assert!(require_trust("graph", level, true).is_ok());
        }
    }

    #[tokio::test]
    async fn a_pending_setup_holds_until_settled_and_only_for_its_hash() {
        let pool = pool().await;
        record(&pool, "plain", "h1").await.unwrap();
        assert!(!setup_pending(&pool, "plain", "h1").await.unwrap());
        record_for_setup(&pool, "graph", "h1").await.unwrap();
        assert!(setup_pending(&pool, "graph", "h1").await.unwrap());
        assert!(!setup_pending(&pool, "graph", "h2").await.unwrap());
        settle_setup(&pool, "graph").await.unwrap();
        assert!(!setup_pending(&pool, "graph", "h1").await.unwrap());
    }
}
