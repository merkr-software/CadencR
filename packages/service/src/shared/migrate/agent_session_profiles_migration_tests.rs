use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::{run_migrations, support, MigrationContext};

const AGENT_SESSION_PROFILES_VERSION: i64 = 20260626120000;

#[tokio::test]
async fn agent_session_profiles_migration_adds_provider_neutral_profile_column() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let pool = test_pool(tmp.path().to_str().unwrap()).await;

    sqlx::raw_sql(
        r#"PRAGMA foreign_keys = ON;
        CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE TABLE agent_sessions (
            id INTEGER PRIMARY KEY,
            feature_id INTEGER NOT NULL REFERENCES features(id),
            agent_type TEXT,
            status TEXT,
            runtime_provider TEXT,
            model TEXT,
            permission_mode TEXT,
            codex_permission_mode TEXT NOT NULL DEFAULT 'default'
        );
        -- The rewind/fork migration (20260627120000) alters agent_messages and
        -- adds turn_checkpoints FK'd to it, so the fixture must provide it.
        CREATE TABLE agent_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL
        );
        INSERT INTO features (id) VALUES (1);
        INSERT INTO agent_sessions
            (id, feature_id, agent_type, status, runtime_provider, model)
        VALUES
            (1, 1, 'session', 'paused', 'claude_code', 'claude-sonnet-4-5');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool).await;

    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    assert!(
        support::table_has_column(&pool, "agent_sessions", "profile")
            .await
            .unwrap()
    );
    let profile: Option<String> =
        sqlx::query_scalar("SELECT profile FROM agent_sessions WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(profile.is_none());
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
        .filter(|migration| migration.version < AGENT_SESSION_PROFILES_VERSION)
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
