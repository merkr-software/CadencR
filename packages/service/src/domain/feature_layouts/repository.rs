use sqlx::{AssertSqlSafe, SqlitePool};

use super::models::FeatureLayout;
use crate::error::AppError;

const SELECT_COLUMNS: &str = "id, name, config, is_default, created_at, updated_at";

pub async fn list(pool: &SqlitePool) -> Result<Vec<FeatureLayout>, AppError> {
    let rows = sqlx::query_as::<_, FeatureLayout>(AssertSqlSafe(format!(
        "SELECT {SELECT_COLUMNS} FROM feature_layouts ORDER BY name ASC, id ASC"
    )))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Option<FeatureLayout>, AppError> {
    let row = sqlx::query_as::<_, FeatureLayout>(AssertSqlSafe(format!(
        "SELECT {SELECT_COLUMNS} FROM feature_layouts WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn insert(pool: &SqlitePool, name: &str, config: &str) -> Result<i64, AppError> {
    let result = sqlx::query("INSERT INTO feature_layouts (name, config) VALUES (?, ?)")
        .bind(name)
        .bind(config)
        .execute(pool)
        .await?;
    Ok(result.last_insert_rowid())
}

/// Partial update: any `None` field keeps its current DB value. `name`
/// uniqueness is enforced by the table-level `UNIQUE` constraint and surfaces
/// here as a sqlx error which `AppError::From` converts to a 500 — the route
/// layer pre-checks for friendlier 4xx feedback when relevant.
pub async fn update(
    pool: &SqlitePool,
    id: i64,
    name: Option<&str>,
    config: Option<&str>,
) -> Result<(), AppError> {
    let result = sqlx::query(
        r#"UPDATE feature_layouts SET
               name       = COALESCE(?, name),
               config     = COALESCE(?, config),
               updated_at = datetime('now')
           WHERE id = ?"#,
    )
    .bind(name)
    .bind(config)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Feature layout {id} not found")));
    }
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM feature_layouts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Feature layout {id} not found")));
    }
    Ok(())
}

/// Atomically promote `id` to default. Wrapped in a transaction so the
/// `is_default = 1` partial-unique index never sees two rows mid-flight.
pub async fn set_default(pool: &SqlitePool, id: i64) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let exists: Option<(i64,)> = sqlx::query_as("SELECT id FROM feature_layouts WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Feature layout {id} not found")));
    }

    sqlx::query("UPDATE feature_layouts SET is_default = 0 WHERE is_default = 1")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE feature_layouts SET is_default = 1, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn insert_then_get_returns_row() {
        let pool = pool().await;
        let id = insert(&pool, "default", r#"{"version":1}"#).await.unwrap();
        let row = get(&pool, id).await.unwrap().unwrap();
        assert_eq!(row.name, "default");
        assert_eq!(row.config, r#"{"version":1}"#);
        assert!(!row.is_default);
    }

    #[tokio::test]
    async fn list_orders_by_name() {
        let pool = pool().await;
        insert(&pool, "z", "{}").await.unwrap();
        insert(&pool, "a", "{}").await.unwrap();
        let rows = list(&pool).await.unwrap();
        assert_eq!(
            rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec!["a", "z"]
        );
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let pool = pool().await;
        insert(&pool, "dup", "{}").await.unwrap();
        let err = insert(&pool, "dup", "{}").await.unwrap_err();
        // SQLite UNIQUE violation surfaces via sqlx as a generic db error;
        // we just assert it propagated rather than silently overwriting.
        assert!(format!("{err}").contains("UNIQUE"));
    }

    #[tokio::test]
    async fn update_partial_keeps_unset_fields() {
        let pool = pool().await;
        let id = insert(&pool, "n", "{}").await.unwrap();
        update(&pool, id, Some("renamed"), None).await.unwrap();
        let row = get(&pool, id).await.unwrap().unwrap();
        assert_eq!(row.name, "renamed");
        assert_eq!(row.config, "{}");
    }

    #[tokio::test]
    async fn update_returns_not_found_for_missing_id() {
        let pool = pool().await;
        let err = update(&pool, 9_999, Some("x"), None).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_removes_row() {
        let pool = pool().await;
        let id = insert(&pool, "n", "{}").await.unwrap();
        delete(&pool, id).await.unwrap();
        assert!(get(&pool, id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_default_promotes_target_and_demotes_previous() {
        let pool = pool().await;
        let a = insert(&pool, "a", "{}").await.unwrap();
        let b = insert(&pool, "b", "{}").await.unwrap();

        set_default(&pool, a).await.unwrap();
        assert!(get(&pool, a).await.unwrap().unwrap().is_default);
        assert!(!get(&pool, b).await.unwrap().unwrap().is_default);

        set_default(&pool, b).await.unwrap();
        assert!(get(&pool, b).await.unwrap().unwrap().is_default);
        assert!(!get(&pool, a).await.unwrap().unwrap().is_default);
    }

    #[tokio::test]
    async fn set_default_rejects_missing_id() {
        let pool = pool().await;
        let err = set_default(&pool, 9_999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
