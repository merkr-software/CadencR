use sqlx::sqlite::SqlitePoolOptions;

use super::test_fixtures::seed_applied_migrations_before;
use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20261009120000;

#[tokio::test]
async fn migration_preserves_reported_windows_and_defaults_new_sessions_to_unknown() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    // Era-accurate shape: the column still carries the baseline's 200000
    // default, and agent_messages FKs into the table whose column is swapped.
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON; \
         CREATE TABLE projects (id INTEGER PRIMARY KEY); \
         CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER \
         REFERENCES projects(id) ON DELETE CASCADE); \
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         feature_id INTEGER NOT NULL REFERENCES features(id), \
         model TEXT, input_tokens INTEGER DEFAULT 0, \
         context_window INTEGER DEFAULT 200000, was_compacted INTEGER DEFAULT 0, \
         runtime_overrides TEXT); \
         CREATE INDEX idx_agent_sessions_feature ON agent_sessions(feature_id); \
         CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL \
         REFERENCES agent_sessions(id)); \
         INSERT INTO projects (id) VALUES (1); \
         INSERT INTO features (id, project_id) VALUES (10, 1); \
         INSERT INTO agent_sessions (id, feature_id, model, input_tokens, context_window) VALUES \
         (100, 10, 'opus', 1200, 1000000), \
         (200, 10, 'haiku', 300, 200000), \
         (300, 10, 'cursor', 0, NULL); \
         INSERT INTO agent_messages (id, session_id) VALUES (1, 100), (2, 200), (3, 300);",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool, TARGET_VERSION).await;

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let sessions: Vec<(i64, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, model, input_tokens, context_window FROM agent_sessions ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        sessions,
        vec![
            (100, "opus".into(), 1200, Some(1_000_000)),
            (200, "haiku".into(), 300, Some(200_000)),
            (300, "cursor".into(), 0, None),
        ]
    );

    // A session created without naming the column no longer claims 200k.
    let fresh: Option<i64> = sqlx::query_scalar(
        "INSERT INTO agent_sessions (feature_id) VALUES (10) RETURNING context_window",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fresh, None);

    let messages: Vec<(i64, i64)> =
        sqlx::query_as("SELECT id, session_id FROM agent_messages ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(messages, vec![(1, 100), (2, 200), (3, 300)]);
    let foreign_key_violations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(foreign_key_violations, 0);
}
