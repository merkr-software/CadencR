//! `20261123120000_agent_sessions_feature_index`: index `agent_sessions` by
//! feature and drop the redundant `agent_messages(session_id)` index, on a
//! database left at the previous release with live rows on both sides of the
//! `agent_messages → agent_sessions → features` foreign keys.

use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20261123120000;

async fn index_names(pool: &SqlitePool, table: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT name FROM pragma_index_list(?)")
        .bind(table)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// A fully migrated database rolled back to the shape the previous release
/// left: the new index absent, the redundant one present, the migration
/// unrecorded.
async fn previous_release_pool() -> SqlitePool {
    let pool = crate::shared::test_query_plan::migrated_pool().await;
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON;
         DROP INDEX idx_agent_sessions_feature_id;
         CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);
         INSERT INTO projects (id, name, path) VALUES (1, 'p', '/p');
         INSERT INTO features (id, project_id, title, status) VALUES (1, 1, 'f', 'active');
         INSERT INTO agent_sessions (id, feature_id, agent_type) VALUES (10, 1, 'session'), (11, 1, 'session');
         INSERT INTO agent_messages (id, session_id, role, content) VALUES
             (100, 10, 'user', 'hi'), (101, 11, 'assistant', 'hello');",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?")
        .bind(TARGET_VERSION)
        .execute(&pool)
        .await
        .unwrap();
    pool
}

#[tokio::test]
async fn upgrade_indexes_sessions_by_feature_and_drops_the_redundant_message_index() {
    let pool = previous_release_pool().await;
    assert!(index_names(&pool, "agent_messages")
        .await
        .contains(&"idx_agent_messages_session".to_string()));

    // The migrator alone: `run_migrations` ends with the startup repair, which
    // would create the same index and hide a broken migration file.
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();

    let applied: bool =
        sqlx::query_scalar("SELECT success FROM _sqlx_migrations WHERE version = ?")
            .bind(TARGET_VERSION)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(applied);
    assert!(index_names(&pool, "agent_sessions")
        .await
        .contains(&"idx_agent_sessions_feature_id".to_string()));
    let message_indexes = index_names(&pool, "agent_messages").await;
    assert!(!message_indexes.contains(&"idx_agent_messages_session".to_string()));
    assert!(message_indexes.contains(&"idx_agent_messages_session_id_desc".to_string()));
    let rows: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM agent_sessions), (SELECT COUNT(*) FROM agent_messages)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, (2, 2));
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);

    // Session-scoped message reads (and the foreign-key child lookup) keep an
    // index: `(session_id, id DESC)` holds the same keys as the dropped one.
    let plan: Vec<(i64, i64, i64, String)> =
        sqlx::query_as("EXPLAIN QUERY PLAN SELECT id FROM agent_messages WHERE session_id = 10")
            .fetch_all(&pool)
            .await
            .unwrap();
    let plan = crate::shared::test_query_plan::plan_details(&plan);
    assert!(plan.contains("USING COVERING INDEX"), "{plan}");
    crate::shared::test_query_plan::assert_no_full_scan(&plan, &[]);
}

#[tokio::test]
async fn legacy_seeded_database_gets_the_index_through_the_repair() {
    // Electron-era databases get every migration recorded as applied without
    // running it, so only `repair_agent_messages_perf_indexes` creates it.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE migrations (version INTEGER PRIMARY KEY);
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL);
         CREATE TABLE agent_messages (
             id INTEGER PRIMARY KEY,
             session_id INTEGER NOT NULL,
             content TEXT NOT NULL,
             message_type TEXT NOT NULL
         );
         CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);",
    )
    .execute(&pool)
    .await
    .unwrap();

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    assert!(index_names(&pool, "agent_sessions")
        .await
        .contains(&"idx_agent_sessions_feature_id".to_string()));
    assert!(!index_names(&pool, "agent_messages")
        .await
        .contains(&"idx_agent_messages_session".to_string()));
}
