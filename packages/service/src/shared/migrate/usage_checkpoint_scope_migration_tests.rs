use std::collections::HashSet;

use sqlx::sqlite::SqlitePoolOptions;

use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20260812120000;

async fn legacy_pool() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE projects (
             id INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             path TEXT NOT NULL UNIQUE,
             branch_prefix TEXT,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             kind TEXT NOT NULL DEFAULT 'user'
         );
         CREATE TABLE agent_sessions (
             id INTEGER PRIMARY KEY,
             runtime_session_id TEXT
         );
         CREATE TABLE provider_usage_checkpoints (
             session_id INTEGER NOT NULL,
             provider_id TEXT NOT NULL,
             input_tokens INTEGER NOT NULL DEFAULT 0,
             output_tokens INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (session_id, provider_id),
             FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
         );
         CREATE TABLE agent_messages (
             id INTEGER PRIMARY KEY,
             session_id INTEGER NOT NULL,
             content TEXT NOT NULL,
             message_type TEXT NOT NULL
         );
         INSERT INTO agent_sessions (id, runtime_session_id)
         VALUES (1, 'codex-root'), (2, 'claude-root'), (3, NULL);
         INSERT INTO provider_usage_checkpoints
             (session_id, provider_id, input_tokens, output_tokens)
         VALUES
             (1, 'codex_cli', 100, 10),
             (2, 'claude_code', 200, 20),
             (3, 'codex_cli', 300, 30);
         PRAGMA foreign_keys = OFF;
         INSERT INTO provider_usage_checkpoints
             (session_id, provider_id, input_tokens, output_tokens)
         VALUES (999, 'codex_cli', 999, 99);
         PRAGMA foreign_keys = ON;",
    )
    .execute(&pool)
    .await
    .unwrap();
    super::test_fixtures::seed_applied_migrations_before(&pool, TARGET_VERSION).await;
    super::test_fixtures::ensure_agent_session_context_window(&pool).await;
    pool
}

#[tokio::test]
async fn upgrade_preserves_existing_checkpoints_and_adds_independent_scopes() {
    let pool = legacy_pool().await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let columns: HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT name FROM pragma_table_info('provider_usage_checkpoints')",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .into_iter()
    .collect();
    assert!(columns.contains("scope_id"));

    let rows: Vec<(i64, String, String, i64, i64)> = sqlx::query_as(
        "SELECT session_id, provider_id, scope_id, input_tokens, output_tokens
         FROM provider_usage_checkpoints
         ORDER BY session_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (1, "codex_cli".into(), String::new(), 100, 10),
            (2, "claude_code".into(), String::new(), 200, 20),
            (3, "codex_cli".into(), String::new(), 300, 30),
        ]
    );

    sqlx::query(
        "INSERT INTO provider_usage_checkpoints
             (session_id, provider_id, scope_id, input_tokens, output_tokens)
         VALUES (1, 'codex_cli', 'codex-child', 40, 4)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM agent_sessions WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let deleted_scopes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM provider_usage_checkpoints WHERE session_id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(deleted_scopes, 0);

    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}

#[tokio::test]
async fn fresh_schema_uses_scoped_usage_checkpoints() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let primary_key: Vec<(String, i64)> = sqlx::query_as(
        "SELECT name, pk FROM pragma_table_info('provider_usage_checkpoints')
         WHERE pk > 0 ORDER BY pk",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        primary_key,
        vec![
            ("session_id".into(), 1),
            ("provider_id".into(), 2),
            ("scope_id".into(), 3),
        ]
    );
}
