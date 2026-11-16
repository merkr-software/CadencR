use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const TARGET_VERSION: i64 = 20260802120000;

async fn seed_migrations_before_target(pool: &SqlitePool) {
    sqlx::query(
        "CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY, description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL, checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .unwrap();

    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < TARGET_VERSION)
    {
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
             VALUES (?, ?, CURRENT_TIMESTAMP, TRUE, ?, 0)",
        )
        .bind(migration.version)
        .bind(&*migration.description)
        .bind(&*migration.checksum)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn legacy_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY);
         CREATE TABLE provider_usage_stats (
             day TEXT NOT NULL,
             provider_id TEXT NOT NULL,
             model_id TEXT NOT NULL DEFAULT '',
             thinking_effort TEXT NOT NULL DEFAULT '',
             input_words INTEGER NOT NULL DEFAULT 0,
             output_words INTEGER NOT NULL DEFAULT 0,
             updated_at TEXT NOT NULL DEFAULT (datetime('now')),
             input_tokens INTEGER NOT NULL DEFAULT 0,
             output_tokens INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (day, provider_id, model_id, thinking_effort)
         );
         CREATE INDEX idx_provider_usage_stats_day ON provider_usage_stats(day);
         CREATE TABLE provider_usage_checkpoints (
             session_id INTEGER NOT NULL,
             provider_id TEXT NOT NULL,
             input_tokens INTEGER NOT NULL DEFAULT 0,
             output_tokens INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (session_id, provider_id),
             FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
         );
         CREATE TABLE provider_usage_events (
             session_id INTEGER NOT NULL,
             provider_id TEXT NOT NULL,
             event_id TEXT NOT NULL,
             PRIMARY KEY (session_id, provider_id, event_id),
             FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
         );
         CREATE TABLE provider_usage_backfill (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             version INTEGER NOT NULL DEFAULT 0,
             cutoff_message_id INTEGER NOT NULL,
             messages_scanned INTEGER NOT NULL DEFAULT 0,
             completed_at TEXT,
             claimed_at TEXT
         );
         INSERT INTO provider_usage_stats
             (day, provider_id, model_id, thinking_effort,
              input_words, output_words, input_tokens, output_tokens, updated_at)
         VALUES ('2026-07-31', 'codex', 'gpt-5.6-sol', 'high', 123, 456, 789, 987,
                 '2026-07-31 12:34:56');
         INSERT INTO provider_usage_backfill
             (id, version, cutoff_message_id, messages_scanned, completed_at, claimed_at)
         VALUES (1, 1, 42, 42, '2026-07-26 01:00:00', '2026-07-26 00:00:00');
         INSERT INTO agent_sessions (id) VALUES (7);
         INSERT INTO provider_usage_checkpoints
             (session_id, provider_id, input_tokens, output_tokens)
         VALUES (7, 'codex', 789, 987);
         INSERT INTO provider_usage_events (session_id, provider_id, event_id)
         VALUES (7, 'codex', 'turn-1');",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_migrations_before_target(&pool).await;
    pool
}

async fn migrate_legacy_pool() -> SqlitePool {
    let pool = legacy_pool().await;
    super::test_fixtures::create_schedules_migration_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();
    pool
}

async fn assert_token_only_schema(pool: &SqlitePool) {
    let columns = support::table_columns(pool, "provider_usage_stats")
        .await
        .unwrap();
    assert_eq!(
        columns,
        [
            "day",
            "provider_id",
            "model_id",
            "thinking_effort",
            "input_tokens",
            "output_tokens",
            "updated_at",
            // Added by 20261011120000, after the word schema was gone.
            "user_messages",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    );
    assert!(!super::table_exists(pool, "provider_usage_backfill")
        .await
        .unwrap());

    let index_columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_index_info('idx_provider_usage_stats_day')")
            .fetch_all(pool)
            .await
            .unwrap();
    assert_eq!(index_columns, vec!["day"]);

    for foreign_key in [
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT \"table\", \"from\", on_delete
             FROM pragma_foreign_key_list('provider_usage_checkpoints')",
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT \"table\", \"from\", on_delete
             FROM pragma_foreign_key_list('provider_usage_events')",
        )
        .fetch_one(pool)
        .await
        .unwrap(),
    ] {
        assert_eq!(
            foreign_key,
            (
                "agent_sessions".into(),
                "session_id".into(),
                "CASCADE".into()
            )
        );
    }
}

#[tokio::test]
async fn upgrade_preserves_tokens_and_removes_word_schema() {
    let pool = migrate_legacy_pool().await;

    let row: (String, String, String, String, i64, i64, String) = sqlx::query_as(
        "SELECT day, provider_id, model_id, thinking_effort,
                input_tokens, output_tokens, updated_at
         FROM provider_usage_stats",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "2026-07-31".into(),
            "codex".into(),
            "gpt-5.6-sol".into(),
            "high".into(),
            789,
            987,
            "2026-07-31 12:34:56".into(),
        )
    );
    assert_token_only_schema(&pool).await;

    let checkpoint: (i64, i64) = sqlx::query_as(
        "SELECT input_tokens, output_tokens FROM provider_usage_checkpoints
         WHERE session_id = 7 AND provider_id = 'codex'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(checkpoint, (789, 987));
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_usage_events
         WHERE session_id = 7 AND provider_id = 'codex' AND event_id = 'turn-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events, 1);

    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}

#[tokio::test]
async fn fresh_and_upgraded_databases_converge_on_token_only_schema() {
    let upgraded = migrate_legacy_pool().await;
    let fresh = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    run_migrations(&MigrationContext::pool_only(&fresh))
        .await
        .unwrap();

    assert_token_only_schema(&upgraded).await;
    assert_token_only_schema(&fresh).await;

    let upgraded_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_usage_stats'",
    )
    .fetch_one(&upgraded)
    .await
    .unwrap();
    let fresh_sql: String = sqlx::query_scalar(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_usage_stats'",
    )
    .fetch_one(&fresh)
    .await
    .unwrap();
    assert_eq!(fresh_sql, upgraded_sql);

    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&fresh)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}
