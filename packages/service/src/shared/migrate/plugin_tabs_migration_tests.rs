use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use super::{run_migrations, MigrationContext};

const TARGET_VERSION: i64 = 20261017090000;

type ProjectMarkerRow = (i64, String, String, Option<String>, Option<String>);

/// The shipped pre-migration `projects` shape (marker columns last) with an
/// ordinary project, a legacy theme project and a marked theme project, each
/// owning children through every kind of FK action that points at `projects`.
async fn legacy_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        "PRAGMA foreign_keys = ON; \
         CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, \
         path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), \
         branch_prefix TEXT, kind TEXT NOT NULL DEFAULT 'user', \
         authoring_target TEXT CHECK (authoring_target IN ('theme', 'provider')), \
         plugin_id TEXT CHECK ((authoring_target IS NULL) = (plugin_id IS NULL))); \
         CREATE UNIQUE INDEX projects_authoring_identity ON projects (authoring_target, plugin_id) \
         WHERE authoring_target IS NOT NULL; \
         CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL \
         REFERENCES projects(id) ON DELETE CASCADE); \
         CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL \
         REFERENCES features(id) ON DELETE CASCADE); \
         CREATE TABLE project_links (id INTEGER PRIMARY KEY, source_project_id INTEGER \
         REFERENCES projects(id) ON DELETE SET NULL); \
         INSERT INTO projects (id, name, path, kind, authoring_target, plugin_id) VALUES \
         (1, 'Ordinary', '/tmp/ordinary', 'user', NULL, NULL), \
         (2, 'Legacy theme', '/tmp/theme', 'theme', NULL, NULL), \
         (3, 'Theme: Dusk', '/tmp/dusk', 'user', 'theme', 'dusk'), \
         (4, 'Provider: Pi', '/tmp/pi', 'user', 'provider', 'pi'); \
         INSERT INTO features (id, project_id) VALUES (10, 1), (20, 2), (30, 3), (40, 4); \
         INSERT INTO agent_sessions (id, feature_id) VALUES (100, 10), (300, 30); \
         INSERT INTO project_links (id, source_project_id) VALUES (1, 3)",
    )
    .execute(&pool)
    .await
    .unwrap();
    super::test_fixtures::seed_applied_migrations_before(&pool, TARGET_VERSION).await;
    super::test_fixtures::ensure_custom_action_schedule_prerequisites(&pool).await;
    pool
}

async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn widening_the_marker_preserves_projects_children_and_markers() {
    let pool = legacy_pool().await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    let projects: Vec<ProjectMarkerRow> = sqlx::query_as(
        "SELECT id, name, kind, authoring_target, plugin_id FROM projects ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        projects,
        vec![
            (1, "Ordinary".into(), "user".into(), None, None),
            (2, "Legacy theme".into(), "theme".into(), None, None),
            (
                3,
                "Theme: Dusk".into(),
                "user".into(),
                Some("theme".into()),
                Some("dusk".into())
            ),
            (
                4,
                "Provider: Pi".into(),
                "user".into(),
                Some("provider".into()),
                Some("pi".into())
            ),
        ]
    );
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM features").await, 4);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM agent_sessions").await, 2);
    assert_eq!(
        count(&pool, "SELECT source_project_id FROM project_links").await,
        3
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM pragma_foreign_key_check").await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'projects_authoring_identity'"
        )
        .await,
        1
    );
}

#[tokio::test]
async fn tab_projects_and_plugin_tab_tables_are_usable_after_migration() {
    let pool = legacy_pool().await;
    run_migrations(&MigrationContext::pool_only(&pool))
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO projects (id, name, path, kind, authoring_target, plugin_id) \
         VALUES (5, 'Tab: Graph', '/tmp/graph', 'user', 'tab', 'graph')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // The marker CHECKs survive the widening.
    for invalid in [
        "INSERT INTO projects (name, path, authoring_target, plugin_id) VALUES ('x', '/x', 'bogus', 'x')",
        "INSERT INTO projects (name, path, authoring_target) VALUES ('x', '/x', 'tab')",
        "INSERT INTO projects (name, path, authoring_target, plugin_id) VALUES ('x', '/x', 'tab', 'graph')",
    ] {
        assert!(sqlx::query(invalid).execute(&pool).await.is_err(), "{invalid}");
    }

    sqlx::raw_sql(
        "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) VALUES \
         ('graph', NULL, 1), ('graph', 5, 0); \
         INSERT INTO plugin_tab_consents (plugin_id, permissions_hash) VALUES ('graph', 'h'); \
         INSERT INTO plugin_tab_config (plugin_id, project_id, key, value) VALUES \
         ('graph', NULL, 'url', '\"https://a\"'), ('graph', 5, 'url', '\"https://b\"'); \
         INSERT INTO plugin_tab_storage (plugin_id, project_id, key, value) VALUES \
         ('graph', 5, 'k', 'v')",
    )
    .execute(&pool)
    .await
    .unwrap();
    // One global row per plugin, one row per (plugin, project).
    for duplicate in [
        "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) VALUES ('graph', NULL, 0)",
        "INSERT INTO plugin_tab_enablements (plugin_id, project_id, enabled) VALUES ('graph', 5, 1)",
        "INSERT INTO plugin_tab_config (plugin_id, project_id, key, value) VALUES ('graph', NULL, 'url', '1')",
        "INSERT INTO plugin_tab_storage (plugin_id, project_id, key, value) VALUES ('graph', 5, 'k', 'w')",
    ] {
        assert!(sqlx::query(duplicate).execute(&pool).await.is_err(), "{duplicate}");
    }

    sqlx::query("DELETE FROM projects WHERE id = 5")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM plugin_tab_enablements").await,
        1,
        "project rows cascade, the global row stays"
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM plugin_tab_config").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM plugin_tab_storage").await,
        0
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM plugin_tab_consents").await,
        1
    );
}
