use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const REWIND_FORK_VERSION: i64 = 20260627120000;

/// Applies the rewind/fork migration onto a realistic post-baseline shape and
/// asserts the additive changes land: the `turn_checkpoints` side table, the
/// nullable `provider_message_uuid` column + its index, and that the checkpoint
/// FK cascades when its parent message is deleted (the rewind delete path).
#[tokio::test]
async fn rewind_fork_migration_adds_checkpoints_and_uuid_column() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = test_pool(tmp.path().to_str().unwrap()).await;

    sqlx::raw_sql(
        r#"PRAGMA foreign_keys = ON;
        CREATE TABLE agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER NOT NULL
        );
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agent_session_message_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_session_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE TABLE scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feature_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            scheduled_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            created_at TEXT,
            updated_at TEXT
        );
        INSERT INTO agent_sessions (id, feature_id) VALUES (1, 1);
        INSERT INTO agent_messages (id, session_id, role, message_type)
            VALUES (10, 1, 'user', 'user_message');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool).await;

    crate::shared::migrate::test_fixtures::create_schedules_migration_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    // Additive schema landed.
    assert!(support::table_exists(&pool, "turn_checkpoints")
        .await
        .unwrap());
    assert!(
        support::table_has_column(&pool, "agent_messages", "provider_message_uuid")
            .await
            .unwrap()
    );
    let indexes: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_index_list('agent_messages')")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        indexes
            .iter()
            .any(|name| name == "idx_agent_messages_provider_uuid"),
        "provider uuid index should exist"
    );

    // Pre-existing rows keep a NULL provider uuid (no rewrite of the hot path).
    let uuid: Option<String> =
        sqlx::query_scalar("SELECT provider_message_uuid FROM agent_messages WHERE id = 10")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(uuid.is_none());

    // The checkpoint FK cascades on parent delete — the rewind delete path
    // relies on this so stale checkpoints don't outlive their message.
    sqlx::query("INSERT INTO turn_checkpoints (message_id, commit_sha) VALUES (10, 'deadbeef')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_messages WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM turn_checkpoints")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 0,
        "checkpoint should cascade-delete with its message"
    );

    let fk_violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk_violations, 0);
}

async fn test_pool(path: &str) -> SqlitePool {
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{path}"))
        .unwrap()
        .create_if_missing(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_applied_migrations_before(pool: &SqlitePool) {
    sqlx::query(
        "CREATE TABLE _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .unwrap();

    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < REWIND_FORK_VERSION)
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
