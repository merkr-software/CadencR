use sqlx::sqlite::SqlitePoolOptions;

use super::{run_migrations, support, MigrationContext};

const TARGET_VERSION: i64 = 20260716120000;

#[tokio::test]
async fn migration_adds_delivery_claims_without_rewriting_reply_waits() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY);
         CREATE TABLE agent_messages (
             id INTEGER PRIMARY KEY,
             session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
             content TEXT NOT NULL DEFAULT ''
         );
         -- Baselined after 20260621120100, so the schedules migration expects
         -- this table to be present and folds it into `schedules`.
         CREATE TABLE scheduled_messages (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             feature_id INTEGER NOT NULL,
             text TEXT NOT NULL,
             scheduled_at TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'pending',
             error TEXT,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now')),
             claim_token TEXT,
             claimed_at TEXT,
             attempt_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE agent_session_reply_waits (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             requester_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
             responder_session_id INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
             request_message_id INTEGER REFERENCES agent_messages(id) ON DELETE SET NULL,
             kind TEXT NOT NULL CHECK (kind IN ('spawn', 'message')),
             status TEXT NOT NULL DEFAULT 'pending' CHECK (
                 status IN ('pending', 'armed', 'delivered', 'failed', 'cancelled')
             ),
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             armed_at TEXT,
             delivered_at TEXT,
             error TEXT
         );
         INSERT INTO agent_sessions (id) VALUES (1), (2);
         INSERT INTO agent_messages (id, session_id) VALUES (10, 2);
         INSERT INTO agent_session_reply_waits
             (id, requester_session_id, responder_session_id, request_message_id, kind, status)
         VALUES (7, 1, 2, 10, 'message', 'armed');",
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
        "delivery_claim_token",
        "delivery_started_at",
        "delivery_message_uuid",
    ] {
        assert!(
            support::table_has_column(&pool, "agent_session_reply_waits", column)
                .await
                .unwrap()
        );
    }
    let claim_index: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_agent_session_reply_waits_active_delivery_claim'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(claim_index, 1);
    let row: (i64, String, Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT id, status, delivery_claim_token, delivery_started_at, delivery_message_uuid
         FROM agent_session_reply_waits WHERE id = 7",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, (7, "armed".into(), None, None, None));
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}

async fn seed_migrations_before_target(pool: &sqlx::SqlitePool) {
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
