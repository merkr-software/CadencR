use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20260724120000;

/// The `scheduled_messages` shape as shipped, i.e. the original table plus the
/// durability columns added by 20260713121500. Includes an orphaned row (a
/// conversation that vanished from a database that ran without
/// `foreign_keys = ON`) so the carry-over insert is exercised against the messy
/// case, not just the happy path.
async fn legacy_schema(pool: &SqlitePool) {
    // sqlx enables `foreign_keys` on every connection, so seeding the orphan
    // means turning enforcement off first — which is precisely how such rows
    // came to exist in older databases. It goes back on before the migration
    // runs, so the carry-over is exercised under enforcement.
    sqlx::raw_sql("PRAGMA foreign_keys = OFF")
        .execute(pool)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL);
         CREATE TABLE features (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL);
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
             attempt_count INTEGER NOT NULL DEFAULT 0,
             FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
         );
         INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
         INSERT INTO features (id, project_id) VALUES (10, 1), (11, 1), (12, 1);
         INSERT INTO scheduled_messages (id, feature_id, text, scheduled_at, status) VALUES
             (1, 10, 'still queued',  '2099-01-01 09:00:00', 'pending'),
             (2, 11, 'mid dispatch',  '2000-01-01 09:00:00', 'dispatching'),
             (3, 10, 'already sent',  '2000-01-01 09:00:00', 'sent'),
             (4, 10, 'gave up',       '2000-01-01 09:00:00', 'failed'),
             (5, 99, 'orphan',        '2099-01-01 09:00:00', 'pending'),
             -- Never fired, and long past due: the upgrade must not swallow it.
             (6, 12, 'overdue pending', '2000-01-01 09:00:00', 'pending');",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::raw_sql("PRAGMA foreign_keys = ON")
        .execute(pool)
        .await
        .unwrap();
}

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

async fn migrated_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    legacy_schema(&pool).await;
    seed_migrations_before_target(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();
    pool
}

#[tokio::test]
async fn migration_carries_over_only_undelivered_scheduled_messages() {
    let pool = migrated_pool().await;

    let carried: Vec<(String, i64, String, String, i64)> = sqlx::query_as(
        "SELECT prompt, feature_id, recurrence_kind, next_run_at, enabled
         FROM schedules ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    // `sent`/`failed` are dead history and the orphan has no conversation to
    // deliver into, so only the live rows survive, as one-shot schedules. A
    // future instant is a real user choice and is carried over untouched; so is
    // a `dispatching` row's, which may already have been delivered.
    assert_eq!(
        carried[0],
        (
            "still queued".into(),
            10,
            "once".into(),
            "2099-01-01 09:00:00".into(),
            1
        )
    );
    assert_eq!(
        carried[1],
        (
            "mid dispatch".into(),
            11,
            "once".into(),
            "2000-01-01 09:00:00".into(),
            1
        )
    );
    assert_eq!(carried.len(), 3);
    let targets: Vec<String> = sqlx::query_scalar("SELECT DISTINCT target_kind FROM schedules")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(targets, vec!["conversation".to_string()]);
}

/// Regression: a message that never fired and came due long before the upgrade
/// is still owed. Carrying its original instant over verbatim would put it
/// outside `planner::CATCH_UP_GRACE`, so the first tick would mark the one-shot
/// skipped and complete it without ever sending the prompt.
#[tokio::test]
async fn an_overdue_pending_message_is_still_delivered_after_the_upgrade() {
    let pool = migrated_pool().await;

    // Clamped to the migration's own clock: due immediately and well inside the
    // grace window, rather than 26 years outside it.
    let deliverable: bool = sqlx::query_scalar(
        "SELECT next_run_at BETWEEN datetime('now', '-5 minutes') AND datetime('now', '+5 minutes')
         FROM schedules WHERE prompt = 'overdue pending'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        deliverable,
        "an overdue pending row kept a stale next_run_at"
    );
}

#[tokio::test]
async fn migration_drops_the_superseded_table_and_leaves_no_fk_violations() {
    let pool = migrated_pool().await;

    assert!(!super::table_exists(&pool, "scheduled_messages")
        .await
        .unwrap());
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}

#[tokio::test]
async fn deleting_a_conversation_removes_its_schedules_but_not_its_history_link() {
    let pool = migrated_pool().await;
    sqlx::raw_sql("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await
        .unwrap();

    // A project-targeted schedule that last ran into feature 10: deleting that
    // conversation must clear the link, not the rule.
    sqlx::query(
        "INSERT INTO schedules
         (prompt, target_kind, project_id, recurrence_kind, timezone, last_feature_id)
         VALUES ('recurring', 'new_conversation', 1, 'daily', 'UTC', 10)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("DELETE FROM features WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();

    let remaining: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT prompt, last_feature_id FROM schedules ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    // The rules targeting other conversations are untouched, and `recurring`
    // keeps its rule with only the history link cleared.
    assert_eq!(
        remaining,
        vec![
            ("mid dispatch".into(), None),
            ("overdue pending".into(), None),
            ("recurring".into(), None),
        ]
    );
}

/// 20260725101500 adds the rest of the composer's runtime options and drops the
/// title template. A schedule carried over from `scheduled_messages` predates
/// all of them, so the columns have to arrive nullable — an added NOT NULL
/// column would have failed the migration outright on any live rule.
#[tokio::test]
async fn runtime_pins_are_added_nullable_and_the_title_template_is_gone() {
    let pool = migrated_pool().await;

    let columns = super::support::table_columns(&pool, "schedules")
        .await
        .unwrap();
    for column in ["permission_mode", "access_mode", "profile"] {
        assert!(columns.contains(column), "missing column {column}");
    }
    assert!(!columns.contains("title_template"));

    let carried: Vec<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT permission_mode, access_mode, profile FROM schedules")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(carried.iter().all(|row| row == &(None, None, None)));

    sqlx::query(
        "INSERT INTO schedules
         (prompt, target_kind, project_id, recurrence_kind, timezone,
          permission_mode, access_mode, profile)
         VALUES ('pinned', 'new_conversation', 1, 'daily', 'UTC', 'plan', 'fullAccess', 'bedrock')",
    )
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn schedules_require_a_target_anchor_for_their_kind() {
    let pool = migrated_pool().await;

    let missing_feature = sqlx::query(
        "INSERT INTO schedules (prompt, target_kind, recurrence_kind, timezone)
         VALUES ('x', 'conversation', 'once', 'UTC')",
    )
    .execute(&pool)
    .await;
    assert!(missing_feature.is_err());

    let missing_project = sqlx::query(
        "INSERT INTO schedules (prompt, target_kind, feature_id, recurrence_kind, timezone)
         VALUES ('x', 'new_conversation', 11, 'once', 'UTC')",
    )
    .execute(&pool)
    .await;
    assert!(missing_project.is_err());
}
