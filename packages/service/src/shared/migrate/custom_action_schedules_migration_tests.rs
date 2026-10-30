use sqlx::SqlitePool;

use super::{run_migrations, test_fixtures::seed_applied_migrations_before, MigrationContext};

const TARGET_VERSION: i64 = 20261029100000;

/// The schema as shipped just before the target: real `custom_actions` and
/// `custom_action_schedules` shapes, and `schedules` built by its own
/// migrations. Seeds a live, a sub-minute, a disabled and two orphaned
/// per-action schedules (orphans can exist in databases that ran without
/// `foreign_keys = ON`), plus an ordinary prompt schedule that must not move.
async fn legacy_pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL);
         CREATE TABLE features (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             project_id INTEGER NOT NULL REFERENCES projects(id),
             title TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE scheduled_messages (
             id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL, text TEXT NOT NULL,
             scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now'))
         );
         CREATE TABLE custom_actions (
             id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, command TEXT NOT NULL,
             icon_data TEXT, scope TEXT NOT NULL CHECK(scope IN ('global','project')),
             project_id INTEGER, position INTEGER NOT NULL DEFAULT 0,
             created_at TEXT NOT NULL DEFAULT (datetime('now')),
             updated_at TEXT NOT NULL DEFAULT (datetime('now')),
             run_in_terminal INTEGER NOT NULL DEFAULT 0,
             FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
         );
         CREATE TABLE custom_action_schedules (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             action_id INTEGER NOT NULL,
             feature_id INTEGER NOT NULL,
             interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 5),
             enabled INTEGER NOT NULL DEFAULT 1,
             last_run_at TEXT,
             FOREIGN KEY (action_id)  REFERENCES custom_actions(id) ON DELETE CASCADE,
             FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
             UNIQUE(action_id, feature_id)
         );",
    )
    .execute(&pool)
    .await
    .unwrap();
    for sql in [
        include_str!("../../../migrations/20260724120000_schedules.sql"),
        include_str!("../../../migrations/20260725101500_schedule_runtime_pins.sql"),
        include_str!("../../../migrations/20261016120000_schedule_command_condition.sql"),
    ] {
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    }
    // Orphans are only insertable with enforcement off — which is how such
    // rows came to exist. It goes back on before the migration runs.
    sqlx::raw_sql(
        "PRAGMA foreign_keys = OFF;
         INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
         INSERT INTO features (id, project_id, title) VALUES (10, 1, 'Main'), (11, 1, 'Side');
         INSERT INTO custom_actions (id, name, command, scope) VALUES
             (1, 'Tests', 'cargo test', 'global'),
             (2, 'Lint', 'cargo clippy', 'global');
         INSERT INTO custom_action_schedules (id, action_id, feature_id, interval_seconds, enabled) VALUES
             (1, 1, 10, 300, 1),
             (2, 2, 10, 5, 1),
             (3, 1, 11, 600, 0),
             (4, 99, 10, 300, 1),
             (5, 1, 99, 300, 1);
         INSERT INTO schedules (id, prompt, target_kind, feature_id, recurrence_kind, interval_seconds)
             VALUES (50, 'review', 'conversation', 11, 'interval', 3600);
         PRAGMA foreign_keys = ON;",
    )
    .execute(&pool)
    .await
    .unwrap();
    seed_applied_migrations_before(&pool, TARGET_VERSION).await;
    super::test_fixtures::ensure_subagent_runs_prerequisites(&pool).await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();
    pool
}

type MigratedRow = (i64, Option<i64>, String, String, String, i64, i64, bool);

#[tokio::test]
async fn live_action_schedules_become_interval_schedules() {
    let pool = legacy_pool().await;

    let rows: Vec<MigratedRow> = sqlx::query_as(
        "SELECT feature_id, custom_action_id, prompt, target_kind, recurrence_kind,
                interval_seconds, enabled,
                next_run_at > datetime('now')
         FROM schedules ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // The prompt schedule is untouched; the disabled row and both orphans are
    // left behind; the 5s interval is floored to the unified 60s minimum; and
    // nothing is due immediately after the upgrade.
    assert_eq!(
        rows,
        vec![
            (
                11,
                None,
                "review".into(),
                "conversation".into(),
                "interval".into(),
                3600,
                1,
                false
            ),
            (
                10,
                Some(1),
                String::new(),
                "conversation".into(),
                "interval".into(),
                300,
                1,
                true
            ),
            (
                10,
                Some(2),
                String::new(),
                "conversation".into(),
                "interval".into(),
                60,
                1,
                true
            ),
        ]
    );
}

#[tokio::test]
async fn the_old_table_is_gone_and_foreign_keys_hold() {
    let pool = legacy_pool().await;

    assert!(
        !super::support::table_exists(&pool, "custom_action_schedules")
            .await
            .unwrap()
    );
    let violations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(violations, 0);
}

#[tokio::test]
async fn deleting_an_action_deletes_its_schedules() {
    let pool = legacy_pool().await;

    sqlx::query("DELETE FROM custom_actions WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let remaining: Vec<Option<i64>> =
        sqlx::query_scalar("SELECT custom_action_id FROM schedules ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, vec![None, Some(2)]);
}
