use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const MESSAGE_UUID_VERSION: i64 = 20260712200000;

#[tokio::test]
async fn message_uuid_migration_preserves_legacy_rows_and_enforces_session_uniqueness() {
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
            session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT 'text',
            tool_name TEXT,
            tool_use_id TEXT,
            parent_tool_use_id TEXT,
            model TEXT,
            provider_message_uuid TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agent_session_message_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
            source_session_id INTEGER,
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
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE agent_session_reply_waits (
            id INTEGER PRIMARY KEY AUTOINCREMENT
        );
        INSERT INTO agent_sessions (id, feature_id) VALUES (1, 10), (2, 20);
        INSERT INTO agent_messages (id, session_id, role, content, message_type)
            VALUES (7, 1, 'user', 'legacy', 'user_message');
        INSERT INTO agent_session_message_queue (id, target_session_id, content)
            VALUES (9, 1, 'legacy queued');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool).await;

    crate::shared::migrate::test_fixtures::create_schedules_migration_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    assert!(
        support::table_has_column(&pool, "agent_messages", "message_uuid")
            .await
            .unwrap()
    );
    assert!(
        support::table_exists(&pool, "agent_message_dispatches")
            .await
            .unwrap(),
        "canonical user-message dispatch lifecycle table should exist"
    );
    let dispatch_columns: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('agent_message_dispatches') ORDER BY cid",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(dispatch_columns.contains(&"await_reply".to_string()));
    assert!(dispatch_columns.contains(&"link_to_current_session".to_string()));
    let legacy: (String, Option<String>) =
        sqlx::query_as("SELECT content, message_uuid FROM agent_messages WHERE id = 7")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(legacy, ("legacy".to_string(), None));
    let legacy_queue: (String, Option<String>) = sqlx::query_as(
        "SELECT content, message_uuid FROM agent_session_message_queue WHERE id = 9",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(legacy_queue, ("legacy queued".to_string(), None));

    let first_message_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages
         (session_id, role, content, message_type, message_uuid)
         VALUES (1, 'user', 'first', 'user_message', 'a48cc11a-8a72-47f7-8577-d5c533d7909c')
         RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_message_dispatches (message_id, status)
         VALUES (?, 'pending')",
    )
    .bind(first_message_id)
    .execute(&pool)
    .await
    .unwrap();
    let invalid_dispatch_status = sqlx::query(
        "INSERT INTO agent_message_dispatches (message_id, status)
         VALUES (7, 'unknown')",
    )
    .execute(&pool)
    .await;
    assert!(
        invalid_dispatch_status.is_err(),
        "dispatch status must be constrained"
    );

    sqlx::query(
        "INSERT INTO agent_session_message_queue
         (target_session_id, content, message_uuid)
         VALUES (1, 'queued first', '293319b5-bf87-48a4-a454-cf9a452d3581')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let duplicate_queue = sqlx::query(
        "INSERT INTO agent_session_message_queue
         (target_session_id, content, message_uuid)
         VALUES (1, 'queued duplicate', '293319b5-bf87-48a4-a454-cf9a452d3581')",
    )
    .execute(&pool)
    .await;
    assert!(
        duplicate_queue.is_err(),
        "same-target queued duplicate UUID must fail"
    );
    sqlx::query(
        "INSERT INTO agent_session_message_queue
         (target_session_id, content, message_uuid)
         VALUES (2, 'queued other session', '293319b5-bf87-48a4-a454-cf9a452d3581')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let duplicate = sqlx::query(
        "INSERT INTO agent_messages
         (session_id, role, content, message_type, message_uuid)
         VALUES (1, 'user', 'duplicate', 'user_message', 'a48cc11a-8a72-47f7-8577-d5c533d7909c')",
    )
    .execute(&pool)
    .await;
    assert!(duplicate.is_err(), "same-session duplicate UUID must fail");

    sqlx::query(
        "INSERT INTO agent_messages
         (session_id, role, content, message_type, message_uuid)
         VALUES (2, 'user', 'other session', 'user_message', 'a48cc11a-8a72-47f7-8577-d5c533d7909c')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("DELETE FROM agent_messages WHERE id = ?")
        .bind(first_message_id)
        .execute(&pool)
        .await
        .unwrap();
    let dispatch_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agent_message_dispatches")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        dispatch_count, 0,
        "dispatch lifecycle rows must cascade with their message"
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
        .filter(|migration| migration.version < MESSAGE_UUID_VERSION)
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
