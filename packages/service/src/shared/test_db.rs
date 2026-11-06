//! Test database helpers: an in-memory pool built from the real migrations, so
//! tests see the production schema and its foreign keys (sqlx enables
//! `foreign_keys` on every connection by default).
//!
//! Intentionally not behind `#[cfg(test)]`, like `AppState::with_pool`, so
//! integration tests under `tests/` (which compile the crate without
//! `cfg(test)`) can use it too. Production code never calls it.

use sqlx::SqlitePool;

use crate::shared::migrate::{run_migrations, MigrationContext};

/// In-memory pool with every migration applied through the production path.
pub async fn migrated_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:")
        .await
        .expect("open in-memory pool");
    run_migrations(&MigrationContext {
        pool: &pool,
        db_path: None,
        app_version: None,
    })
    .await
    .expect("apply migrations");
    pool
}

pub async fn insert_project(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO projects (name, path) VALUES ('project', '/tmp/project') RETURNING id",
    )
    .fetch_one(pool)
    .await
    .expect("insert project")
}

pub async fn insert_conversation(pool: &SqlitePool, project_id: i64) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO features (project_id, title, status, type)
         VALUES (?, 'conversation', 'active', 'ws-session') RETURNING id",
    )
    .bind(project_id)
    .fetch_one(pool)
    .await
    .expect("insert conversation")
}

pub async fn insert_session(pool: &SqlitePool, feature_id: i64) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO agent_sessions (feature_id, agent_type) VALUES (?, 'session') RETURNING id",
    )
    .bind(feature_id)
    .fetch_one(pool)
    .await
    .expect("insert session")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrated_pool_enforces_the_real_foreign_keys() {
        let pool = migrated_pool().await;
        let enabled: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(enabled, 1);
        let diff_comment_fks: i64 =
            sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_list('diff_comments')")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(diff_comment_fks > 0);

        let orphan = sqlx::query("INSERT INTO features (project_id, title) VALUES (999, 'orphan')")
            .execute(&pool)
            .await;
        assert!(
            orphan.is_err(),
            "a conversation without its project must be rejected"
        );
    }

    #[tokio::test]
    async fn builders_chain_into_valid_rows() {
        let pool = migrated_pool().await;
        let project_id = insert_project(&pool).await;
        let feature_id = insert_conversation(&pool, project_id).await;
        let session_id = insert_session(&pool, feature_id).await;
        let owner: i64 = sqlx::query_scalar(
            "SELECT f.project_id FROM agent_sessions s JOIN features f ON f.id = s.feature_id WHERE s.id = ?",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner, project_id);
    }
}
