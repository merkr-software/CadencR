use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const MCP_ORCHESTRATION_SCHEMA_VERSION: i64 = 20260618120000;

#[tokio::test]
async fn mcp_orchestration_migration_adds_provenance_links_and_fts() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = test_pool(tmp.path().to_str().unwrap()).await;

    sqlx::raw_sql(
        r#"PRAGMA foreign_keys = ON;
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
        CREATE TABLE features (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id),
            title TEXT NOT NULL
        );
        -- is_pinned is dropped by migration 20260621130000 but existed at this
        -- baseline (added by 20260504001317), so the fixture must provide it.
        -- (Keep it comment-free *inside* the parens: SQLite's DROP COLUMN
        -- re-parses the stored CREATE TABLE and chokes on inline comments.)
        CREATE TABLE agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER NOT NULL REFERENCES features(id),
            agent_type TEXT,
            status TEXT,
            model TEXT,
            codex_permission_mode TEXT NOT NULL DEFAULT 'default',
            is_pinned INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES agent_sessions(id),
            role TEXT NOT NULL DEFAULT 'assistant',
            content TEXT NOT NULL,
            message_type TEXT NOT NULL DEFAULT 'text',
            tool_name TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            tool_use_id TEXT,
            parent_tool_use_id TEXT,
            model TEXT DEFAULT NULL
        );
        CREATE TABLE custom_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'global',
            run_in_terminal INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO projects (id, name, path) VALUES (1, 'One', '/tmp/one');
        INSERT INTO features (id, project_id, title) VALUES (10, 1, 'Parent'), (20, 1, 'Child');
        INSERT INTO agent_sessions (id, feature_id, agent_type, status)
        VALUES (100, 10, 'session', 'paused'), (200, 20, 'session', 'running');
        INSERT INTO agent_messages (id, session_id, role, content, message_type)
        VALUES (1000, 100, 'assistant', 'orchestration backfill seed', 'text');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool).await;

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    for table in [
        "agent_message_origins",
        "agent_session_links",
        "agent_messages_fts",
        "mcp_tool_audit_log",
        "agent_session_message_queue",
    ] {
        assert!(
            support::table_exists(&pool, table).await.unwrap(),
            "missing {table}"
        );
    }

    sqlx::query(
        "INSERT INTO mcp_tool_audit_log
         (server_name, tool_name, source_session_id, source_feature_id, source_project_id, target_session_id, status, result_size_bytes, latency_ms)
         VALUES ('cadencr-project', 'project_spawn_session', 100, 10, 1, 200, 'ok', 128, 7)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mcp_tool_audit_log
         WHERE tool_name = 'project_spawn_session' AND source_session_id = 100",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);

    sqlx::query(
        "INSERT INTO agent_session_message_queue
         (target_session_id, source_session_id, content)
         VALUES (200, 100, 'queued helper prompt')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let queued: (i64, i64, String, String) = sqlx::query_as(
        "SELECT target_session_id, source_session_id, content, status
         FROM agent_session_message_queue",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        queued,
        (200, 100, "queued helper prompt".into(), "pending".into())
    );

    let backfilled: i64 = sqlx::query_scalar(
        "SELECT rowid FROM agent_messages_fts WHERE agent_messages_fts MATCH 'orchestration'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(backfilled, 1000);

    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (1000, 'session_generated', 200, 20, 1, 'delegated')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (100, 200, 'spawned', 'helper')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO agent_messages (id, session_id, role, content, message_type)
         VALUES (1001, 100, 'user', 'trigger searchable insert', 'user_message')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let inserted: i64 = sqlx::query_scalar(
        "SELECT rowid FROM agent_messages_fts WHERE agent_messages_fts MATCH 'searchable'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(inserted, 1001);

    sqlx::query("UPDATE agent_messages SET content = 'updated searchable text' WHERE id = 1001")
        .execute(&pool)
        .await
        .unwrap();
    let updated: i64 = sqlx::query_scalar(
        "SELECT rowid FROM agent_messages_fts WHERE agent_messages_fts MATCH 'updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(updated, 1001);

    sqlx::query("DELETE FROM agent_messages WHERE id = 1001")
        .execute(&pool)
        .await
        .unwrap();
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages_fts WHERE agent_messages_fts MATCH 'updated'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);

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
        .filter(|migration| migration.version < MCP_ORCHESTRATION_SCHEMA_VERSION)
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
