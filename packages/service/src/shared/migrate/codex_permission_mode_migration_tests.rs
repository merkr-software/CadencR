use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const CODEX_PERMISSION_MODE_VERSION: i64 = 20260526120000;

#[tokio::test]
async fn codex_permission_mode_migration_adds_session_column() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = test_pool(tmp.path().to_str().unwrap()).await;

    sqlx::raw_sql(
        r#"PRAGMA foreign_keys = ON;
        -- is_pinned is dropped by migration 20260621130000 but existed at this
        -- baseline (added by 20260504001317), so the fixture must provide it.
        -- Keep it comment-free inside the parens: SQLite's DROP COLUMN re-parses
        -- the stored CREATE TABLE and chokes on inline comments.
        CREATE TABLE agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER NOT NULL,
            agent_type TEXT,
            status TEXT,
            model TEXT,
            permission_mode TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0
        );
        -- Later migrations (e.g. the user-message sort indexes) reference
        -- agent_messages(role, created_at), so the fixture must provide them.
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'assistant',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- The pin_features migration (20260621120000) alters features, which
        -- already existed at this baseline, so the fixture must provide it.
        CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT);
        -- The run_in_terminal migration (20260609120000) alters custom_actions,
        -- which already existed at this baseline, so the fixture must provide it.
        CREATE TABLE custom_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'global'
        );
        INSERT INTO agent_sessions (id, feature_id, agent_type, status, model, permission_mode)
        VALUES (1, 1, 'session', 'paused', 'gpt-5.5', 'plan');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool).await;

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    assert!(
        support::table_has_column(&pool, "agent_sessions", "codex_permission_mode")
            .await
            .unwrap()
    );
    let mode: String =
        sqlx::query_scalar("SELECT codex_permission_mode FROM agent_sessions WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(mode, "default");
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
        .filter(|migration| migration.version < CODEX_PERMISSION_MODE_VERSION)
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
