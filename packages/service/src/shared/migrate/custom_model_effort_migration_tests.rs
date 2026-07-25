use sqlx::sqlite::SqlitePoolOptions;

use super::{run_migrations, support, MigrationContext};

#[tokio::test]
async fn migration_preserves_existing_custom_models_with_unknown_effort() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON; \
         CREATE TABLE claude_code_custom_models (id INTEGER PRIMARY KEY, model_id TEXT NOT NULL \
         UNIQUE, label TEXT NOT NULL, description TEXT, created_at DATETIME NOT NULL DEFAULT \
         CURRENT_TIMESTAMP); \
         CREATE TABLE agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT \
         NULL); \
         CREATE TABLE agent_session_message_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, \
         target_session_id INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT \
         'pending'); \
         CREATE TABLE scheduled_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER \
         NOT NULL, text TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT \
         'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL \
         DEFAULT (datetime('now'))); \
         CREATE TABLE agent_session_reply_waits (id INTEGER PRIMARY KEY AUTOINCREMENT); \
         INSERT INTO claude_code_custom_models (model_id, label, description) \
         VALUES ('legacy-proxy', 'Legacy proxy', 'keep me')",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_migrations_before_target(&pool).await;

    crate::shared::migrate::test_fixtures::create_schedules_migration_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    for column in [
        "supports_effort",
        "supported_effort_levels_json",
        "default_effort_level",
    ] {
        assert!(
            support::table_has_column(&pool, "claude_code_custom_models", column)
                .await
                .unwrap()
        );
    }
    let row: (String, Option<bool>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT description, supports_effort, supported_effort_levels_json, default_effort_level \
         FROM claude_code_custom_models WHERE model_id = 'legacy-proxy'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, ("keep me".into(), None, None, None));
    let foreign_key_violations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(foreign_key_violations, 0);
}

async fn seed_migrations_before_target(pool: &sqlx::SqlitePool) {
    sqlx::query(
        "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, \
         installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, \
         checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)",
    )
    .execute(pool)
    .await
    .unwrap();
    let migrator = sqlx::migrate!("./migrations");
    for migration in migrator
        .iter()
        .filter(|migration| migration.version < 20260713120000)
    {
        sqlx::query("INSERT INTO _sqlx_migrations VALUES (?, ?, CURRENT_TIMESTAMP, TRUE, ?, 0)")
            .bind(migration.version)
            .bind(&*migration.description)
            .bind(&*migration.checksum)
            .execute(pool)
            .await
            .unwrap();
    }
}
