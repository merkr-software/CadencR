//! A tab's own key/value store, per project (`plugin_tab_storage`, §4.3).
//!
//! Values are arbitrary JSON, bounded so one plugin cannot grow the database
//! without limit: ≤ 256 KiB serialized, ≤ 500 keys per plugin and project,
//! keys ≤ 128 chars of `[A-Za-z0-9_.:-]`.

use axum::http::StatusCode;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;

pub const MAX_VALUE_BYTES: usize = 256 * 1024;
pub const MAX_KEYS: i64 = 500;
pub const MAX_KEY_CHARS: usize = 128;

/// Which store: one per plugin and project.
#[derive(Debug, Clone, Copy)]
pub struct StorageScope<'a> {
    pub plugin_id: &'a str,
    pub project_id: i64,
}

pub fn validate_key(key: &str) -> Result<(), AppError> {
    let valid = !key.is_empty()
        && key.len() <= MAX_KEY_CHARS
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte));
    if valid {
        return Ok(());
    }
    Err(AppError::coded(
        StatusCode::BAD_REQUEST,
        "PLUGIN_TAB_STORAGE_KEY_INVALID",
        format!("storage keys are 1–{MAX_KEY_CHARS} characters of A-Z a-z 0-9 _ . : -"),
    ))
}

/// Every key, sorted.
pub async fn list(pool: &SqlitePool, scope: StorageScope<'_>) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT key FROM plugin_tab_storage WHERE plugin_id = ? AND project_id = ? ORDER BY key",
    )
    .bind(scope.plugin_id)
    .bind(scope.project_id)
    .fetch_all(pool)
    .await?)
}

/// The stored value, or 404 `PLUGIN_TAB_STORAGE_NOT_FOUND`.
pub async fn get(pool: &SqlitePool, scope: StorageScope<'_>, key: &str) -> Result<Value, AppError> {
    validate_key(key)?;
    let text: Option<String> = sqlx::query_scalar(
        "SELECT value FROM plugin_tab_storage WHERE plugin_id = ? AND project_id = ? AND key = ?",
    )
    .bind(scope.plugin_id)
    .bind(scope.project_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    let text = text.ok_or_else(|| {
        AppError::coded(
            StatusCode::NOT_FOUND,
            "PLUGIN_TAB_STORAGE_NOT_FOUND",
            format!("no stored value for `{key}`"),
        )
    })?;
    serde_json::from_str(&text).map_err(|error| {
        AppError::internal(format!(
            "stored custom tab value `{key}` is not JSON: {error}"
        ))
    })
}

/// Insert or replace `key`. The key-count check and the write share one
/// transaction, so concurrent writes cannot overshoot the quota.
pub async fn put(
    pool: &SqlitePool,
    scope: StorageScope<'_>,
    key: &str,
    value: &Value,
) -> Result<(), AppError> {
    validate_key(key)?;
    let text = value.to_string();
    if text.len() > MAX_VALUE_BYTES {
        return Err(AppError::coded(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PLUGIN_TAB_STORAGE_VALUE_TOO_LARGE",
            format!(
                "a stored value is at most {} KiB of JSON",
                MAX_VALUE_BYTES / 1024
            ),
        ));
    }
    let mut tx = pool.begin().await?;
    let (count, exists): (i64, bool) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(MAX(key = ?), 0) FROM plugin_tab_storage \
         WHERE plugin_id = ? AND project_id = ?",
    )
    .bind(key)
    .bind(scope.plugin_id)
    .bind(scope.project_id)
    .fetch_one(&mut *tx)
    .await?;
    if !exists && count >= MAX_KEYS {
        return Err(AppError::coded(
            StatusCode::CONFLICT,
            "PLUGIN_TAB_STORAGE_FULL",
            format!("a custom tab stores at most {MAX_KEYS} keys per project; delete some first"),
        ));
    }
    sqlx::query(
        "INSERT INTO plugin_tab_storage (plugin_id, project_id, key, value) VALUES (?, ?, ?, ?) \
         ON CONFLICT (plugin_id, project_id, key) \
         DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    )
    .bind(scope.plugin_id)
    .bind(scope.project_id)
    .bind(key)
    .bind(text)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Remove `key`; removing an absent key succeeds.
pub async fn delete(pool: &SqlitePool, scope: StorageScope<'_>, key: &str) -> Result<(), AppError> {
    validate_key(key)?;
    sqlx::query(
        "DELETE FROM plugin_tab_storage WHERE plugin_id = ? AND project_id = ? AND key = ?",
    )
    .bind(scope.plugin_id)
    .bind(scope.project_id)
    .bind(key)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::{insert_project, pool};
    use serde_json::json;

    fn code(error: AppError) -> &'static str {
        match error {
            AppError::Coded { code, .. } => code,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn keys_are_bounded_identifiers() {
        for key in ["a", "layout.v2", "graph:zoom", "A-b_c", &"k".repeat(128)] {
            assert!(validate_key(key).is_ok(), "{key}");
        }
        for key in ["", "a b", "a/b", "é", &"k".repeat(129)] {
            assert_eq!(
                code(validate_key(key).unwrap_err()),
                "PLUGIN_TAB_STORAGE_KEY_INVALID"
            );
        }
    }

    #[tokio::test]
    async fn stores_json_per_plugin_and_project() {
        let pool = pool().await;
        let p = insert_project(&pool, "p").await;
        let q = insert_project(&pool, "q").await;
        let mine = StorageScope {
            plugin_id: "graph",
            project_id: p,
        };
        let other_project = StorageScope {
            plugin_id: "graph",
            project_id: q,
        };
        let other_plugin = StorageScope {
            plugin_id: "other",
            project_id: p,
        };

        assert_eq!(
            code(get(&pool, mine, "zoom").await.unwrap_err()),
            "PLUGIN_TAB_STORAGE_NOT_FOUND"
        );
        put(&pool, mine, "zoom", &json!({"level": 2}))
            .await
            .unwrap();
        put(&pool, mine, "zoom", &json!({"level": 3}))
            .await
            .unwrap();
        put(&pool, mine, "a", &json!(null)).await.unwrap();
        assert_eq!(get(&pool, mine, "zoom").await.unwrap(), json!({"level": 3}));
        assert_eq!(list(&pool, mine).await.unwrap(), ["a", "zoom"]);
        assert!(list(&pool, other_project).await.unwrap().is_empty());
        assert!(list(&pool, other_plugin).await.unwrap().is_empty());
        delete(&pool, mine, "zoom").await.unwrap();
        delete(&pool, mine, "zoom").await.unwrap();
        assert_eq!(list(&pool, mine).await.unwrap(), ["a"]);
    }

    #[tokio::test]
    async fn enforces_value_size_and_key_quota() {
        let pool = pool().await;
        let p = insert_project(&pool, "p").await;
        let scope = StorageScope {
            plugin_id: "graph",
            project_id: p,
        };
        let big = json!("x".repeat(MAX_VALUE_BYTES));
        assert_eq!(
            code(put(&pool, scope, "big", &big).await.unwrap_err()),
            "PLUGIN_TAB_STORAGE_VALUE_TOO_LARGE"
        );
        for index in 0..MAX_KEYS {
            put(&pool, scope, &format!("k{index}"), &json!(index))
                .await
                .unwrap();
        }
        assert_eq!(
            code(put(&pool, scope, "one-more", &json!(1)).await.unwrap_err()),
            "PLUGIN_TAB_STORAGE_FULL"
        );
        // Replacing an existing key is not growth.
        put(&pool, scope, "k0", &json!("again")).await.unwrap();
    }
}
