#[cfg(test)]
use sqlx::AssertSqlSafe;
use sqlx::SqlitePool;
use std::path::Path;
use tracing::{info, warn};
#[cfg(test)]
mod agent_session_profiles_migration_tests;
mod backup_rotation;
mod checksum_repair;
mod checksum_repair_data;
#[cfg(test)]
mod codex_permission_mode_migration_tests;
#[cfg(test)]
mod context_window_null_default_migration_tests;
#[cfg(test)]
mod custom_model_effort_migration_tests;
#[cfg(test)]
mod mcp_orchestration_migration_tests;
#[cfg(test)]
mod message_uuid_migration_tests;
#[cfg(test)]
mod narrow_fts_migration_tests;
#[cfg(test)]
mod project_authoring_marker_migration_tests;
#[cfg(test)]
mod reply_wait_claim_migration_tests;
#[cfg(test)]
mod rewind_fork_migration_tests;
#[cfg(test)]
mod schedules_migration_tests;
mod seed;
mod support;
#[cfg(test)]
mod test_fixtures;
#[cfg(test)]
mod usage_checkpoint_scope_migration_tests;
#[cfg(test)]
mod usage_token_schema_migration_tests;
mod version_guard;
use crate::shared::startup_progress::emit_phase;
pub(crate) use backup_rotation::naming::source_database_file_name as backup_source_database_file_name;
pub(crate) use support::table_exists;
use support::{backup_database, has_pending_migrations};
const NARROW_AGENT_MESSAGES_FTS_VERSION: i64 = 20260803122000;
/// Inputs for a single startup migration pass.
pub struct MigrationContext<'a> {
    pub pool: &'a SqlitePool,
    /// Path to the SQLite file we'll back up before applying pending migrations.
    /// `None` skips backup (used in tests against `:memory:` or temp files).
    pub db_path: Option<&'a Path>,
    /// Version label used in the backup filename. Falls back to `"unknown"` if `None`.
    pub app_version: Option<&'a str>,
}
#[cfg(test)]
impl<'a> MigrationContext<'a> {
    /// Pool-only context, intended for tests that don't care about backups.
    pub fn pool_only(pool: &'a SqlitePool) -> Self {
        Self {
            pool,
            db_path: None,
            app_version: None,
        }
    }
}
/// Run database migrations defensively.
///
/// For existing databases (detected by the presence of the old Electron `migrations` table),
/// we seed sqlx's `_sqlx_migrations` table so the baseline is marked as already-applied.
/// For fresh databases, sqlx runs the baseline to create the full schema.
///
/// Returns an error if any migration fails — the caller must abort startup.
pub async fn run_migrations(ctx: &MigrationContext<'_>) -> anyhow::Result<()> {
    let migrator = sqlx::migrate!("./migrations");
    if table_exists(ctx.pool, "migrations").await? {
        seed::seed_sqlx_migrations(ctx.pool, &migrator).await?;
    }
    version_guard::ensure_database_not_newer(ctx.pool, &migrator).await?;

    let has_pending = has_pending_migrations(ctx.pool, &migrator).await?;
    let rebuilds_conversation_search = has_pending
        && support::is_upgrade_migration_pending(ctx.pool, NARROW_AGENT_MESSAGES_FTS_VERSION)
            .await?;
    if has_pending {
        if let Some(db_path) = ctx.db_path {
            match backup_database(ctx.pool, db_path, ctx.app_version).await {
                Ok(Some(backup)) => {
                    info!(backup = %backup.display(), "pre-migration backup written");
                    // Each snapshot is a full copy of the database, so an
                    // unbounded set outgrows the database itself. Prune after
                    // the new one lands, so a failed backup never costs us the
                    // older snapshots we still have.
                    let pruned = backup_rotation::prune(db_path, &backup);
                    if pruned > 0 {
                        info!(pruned, "removed superseded pre-migration backups");
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    // Refuse to migrate without a backup. Pending migrations
                    // include schema rebuilds that cannot be undone, so
                    // continuing here would trade the user's only safety net for
                    // a faster launch. Failing leaves the database untouched and
                    // the app bootable again as soon as the cause is fixed —
                    // usually free disk space, which the preflight names.
                    warn!("pre-migration backup failed: {error}");
                    emit_phase("backup_failed", &error.to_string());
                    return Err(error.context(
                        "refusing to run database migrations without a pre-migration backup",
                    ));
                }
            }
        }
    }

    checksum_repair::repair_known_sqlx_checksum_mismatches(ctx.pool, &migrator).await?;
    seed::repair_agent_messages_content_column(ctx.pool).await?;
    if has_pending {
        let detail = if rebuilds_conversation_search {
            "Rebuilding conversation search without bulky tool results. Conversation data is not being deleted."
        } else {
            "Applying database schema updates. Your conversations are preserved."
        };
        crate::shared::startup_progress::run_phase("migrating", detail, migrator.run(ctx.pool))
            .await?;
    } else {
        migrator.run(ctx.pool).await?;
    }
    seed::repair_agent_message_content_revisions(ctx.pool).await?;
    seed::repair_agent_messages_perf_indexes(ctx.pool).await?;

    info!("Database migrations completed successfully");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::create_pre_agent_message_index_schema;
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

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

    #[tokio::test]
    async fn test_fresh_db() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_sqlx%' AND name != 'sqlite_sequence' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        for required in [
            "projects",
            "features",
            "agent_sessions",
            "agent_messages",
            "settings",
        ] {
            assert!(tables.contains(&required.to_string()), "missing {required}");
        }
    }

    #[tokio::test]
    async fn new_message_resets_compaction_for_an_archived_feature() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let pool = test_pool(tmp.path().to_str().unwrap()).await;
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        sqlx::raw_sql(
            r#"CREATE TABLE feature_update_audit (updates INTEGER NOT NULL);
            INSERT INTO feature_update_audit (updates) VALUES (0);
            CREATE TRIGGER count_feature_updates AFTER UPDATE ON features BEGIN
                UPDATE feature_update_audit SET updates = updates + 1;
            END;
            INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
            INSERT INTO features
                (id, project_id, title, status, archived_at, compacted_at)
                VALUES (1, 1, 'Archived', 'archived',
                        datetime('now', '-60 days'), datetime('now'));
            INSERT INTO agent_sessions (id, feature_id, agent_type)
                VALUES (1, 1, 'session');
            INSERT INTO agent_messages
                (id, session_id, role, content, message_type)
                VALUES (1, 1, 'user', 'scheduled follow-up', 'user_message');"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let compacted_at: Option<String> =
            sqlx::query_scalar("SELECT compacted_at FROM features WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(compacted_at.is_none());

        sqlx::query(
            "INSERT INTO agent_messages
             (id, session_id, role, content, message_type)
             VALUES (2, 1, 'user', 'another follow-up', 'user_message')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let feature_updates: i64 = sqlx::query_scalar("SELECT updates FROM feature_update_audit")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            feature_updates, 1,
            "only the first message invalidates compaction"
        );
    }

    #[tokio::test]
    async fn test_idempotent() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn backup_runs_when_pending_skips_when_current() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("cadencr.db");
        let pool = test_pool(db.to_str().unwrap()).await;
        let ctx = MigrationContext {
            pool: &pool,
            db_path: Some(&db),
            app_version: Some("9.9.9"),
        };

        run_migrations(&ctx).await.unwrap();
        let prefix = format!(
            "{}.9.9.9.",
            backup_rotation::naming::database_identity(&db).unwrap()
        );
        let backups = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .count();
        assert_eq!(backups, 1, "first run must back up");

        run_migrations(&ctx).await.unwrap();
        let backups_again = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .count();
        assert_eq!(
            backups_again, 1,
            "no pending migrations means no second backup"
        );
    }

    #[tokio::test]
    async fn remove_ws_feature_migration_preserves_live_session_children() {
        const REMOVE_WS_FEATURE_VERSION: i64 = 20260514123657;

        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;
        create_pre_ws_feature_removal_schema(&pool).await;
        test_fixtures::seed_applied_migrations_before(&pool, REMOVE_WS_FEATURE_VERSION).await;
        test_fixtures::ensure_agent_session_context_window(&pool).await;

        sqlx::raw_sql(
            r#"INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p');
            INSERT INTO features (id, project_id, title, status, type, agent_runtime_session) VALUES
                (1, 1, 'Session 1', 'active', 'ws-session', 'opencode'),
                (2, 1, 'Hidden', 'archived', 'ws-session', NULL),
                (3, 1, 'Draft Legacy Session', 'draft', 'ws-session', NULL);
            INSERT INTO settings (key, value) VALUES
                ('model_qa', 'default'),
                ('agent_autonomy', '1');
            INSERT INTO project_settings (project_id, key, value) VALUES
                (1, 'parallel_execution', 'true');
            INSERT INTO feature_settings (feature_id, key, value) VALUES
                (1, 'worktree_path', '/tmp/p'),
                (1, 'model_qa', 'default');"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::raw_sql(
            r#"PRAGMA foreign_keys = OFF;
            INSERT INTO workflow_queue (id, feature_id, agent_session_id) VALUES (788, 663, 2163);
            INSERT INTO agent_sessions (id, feature_id) VALUES (2163, 663);
            INSERT INTO workflow_queue (id, feature_id, agent_session_id) VALUES (789, 1, 2164);
            INSERT INTO agent_sessions (id, feature_id) VALUES (2164, 664);
            INSERT INTO workflow_dependencies (id, queue_item_id, depends_on_item_id) VALUES (1, 789, 788);
            PRAGMA foreign_keys = ON;"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        let runtime: String =
            sqlx::query_scalar("SELECT agent_runtime_session FROM features WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(runtime, "opencode");

        let setting_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM feature_settings WHERE feature_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(setting_count, 1);

        assert!(table_has_column(&pool, "features", "status").await);
        // A trailing ORDER BY would sort the single aggregate row, not the rows
        // feeding group_concat — leaving the concatenation in whatever order the
        // planner happened to scan. Order inside a subquery so the expectation
        // holds regardless of which index a later migration makes available.
        let statuses: String = sqlx::query_scalar(
            "SELECT group_concat(entry, ',') FROM \
             (SELECT id || ':' || status AS entry FROM features ORDER BY id)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(statuses, "1:active,2:archived,3:active");
        assert!(!table_has_column(&pool, "agent_sessions", "pending_plan_approval").await);
        for removed_feature_column in [
            "model_qa",
            "agent_runtime_qa",
            "agent_autonomy",
            "parallel_execution",
        ] {
            assert!(
                !table_has_column(&pool, "features", removed_feature_column).await,
                "{removed_feature_column} should be removed from features"
            );
        }
        for removed_project_column in [
            "model_qa",
            "agent_runtime_qa",
            "agent_autonomy",
            "parallel_execution",
            "qa_prompt",
        ] {
            assert!(
                !table_has_column(&pool, "projects", removed_project_column).await,
                "{removed_project_column} should be removed from projects"
            );
        }
        for table in ["settings", "project_settings", "feature_settings"] {
            let count: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT COUNT(*) FROM {table} WHERE key IN ('model_qa', 'agent_autonomy', 'parallel_execution')"
            )))
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, 0, "{table} should not retain legacy EAV keys");
        }
        assert!(!super::support::table_exists(&pool, "workflow_queue")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn agent_messages_perf_index_migration_runs_on_existing_schema() {
        const AGENT_MESSAGE_INDEX_VERSION: i64 = 20260522120000;
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        create_pre_agent_message_index_schema(&pool).await;
        // The schedules migration (20260724120000) folds `scheduled_messages`
        // into `schedules`, which FKs into projects/features.
        test_fixtures::create_schedules_migration_prerequisites(&pool).await;
        test_fixtures::seed_applied_migrations_before(&pool, AGENT_MESSAGE_INDEX_VERSION).await;
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        let indexes: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_index_list('agent_messages')")
                .fetch_all(&pool)
                .await
                .unwrap();
        for expected in [
            "idx_agent_messages_session_id_desc",
            "idx_agent_messages_session_type_tool",
            "idx_agent_messages_session_tool_use",
        ] {
            assert!(
                indexes.contains(&expected.to_string()),
                "missing {expected}"
            );
        }

        let fk_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(fk_violations, 0);
    }

    #[tokio::test]
    async fn drop_agent_sessions_pin_migration_removes_column_and_index() {
        const DROP_PIN_VERSION: i64 = 20260621130000;
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();

        // Old shape: the per-session pin column and its index, as shipped by
        // migration 20260504001317. A pinned row must survive the column drop.
        sqlx::raw_sql(
            r#"CREATE TABLE agent_sessions (
                id INTEGER PRIMARY KEY,
                feature_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'idle',
                is_pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX idx_agent_sessions_is_pinned ON agent_sessions(is_pinned);
            -- The rewind/fork migration (20260627120000) alters agent_messages
            -- and adds turn_checkpoints FK'd to it, so the fixture must provide it.
            CREATE TABLE agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL
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
            INSERT INTO agent_sessions (id, feature_id, status, is_pinned)
                VALUES (1, 7, 'running', 1);"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        // The schedules migration (20260724120000) folds `scheduled_messages`
        // into `schedules`, which FKs into projects/features.
        test_fixtures::create_schedules_migration_prerequisites(&pool).await;
        test_fixtures::seed_applied_migrations_before(&pool, DROP_PIN_VERSION).await;

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        assert!(!table_has_column(&pool, "agent_sessions", "is_pinned").await);
        let indexes: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_index_list('agent_sessions')")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(
            !indexes
                .iter()
                .any(|name| name == "idx_agent_sessions_is_pinned"),
            "pin index should be dropped"
        );

        // Non-pin data on the row is preserved across the column drop.
        let feature_id: i64 =
            sqlx::query_scalar("SELECT feature_id FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(feature_id, 7);

        let fk_violations: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(fk_violations, 0);
    }

    async fn table_has_column(pool: &SqlitePool, table_name: &str, column_name: &str) -> bool {
        super::support::table_has_column(pool, table_name, column_name)
            .await
            .unwrap()
    }

    async fn create_pre_ws_feature_removal_schema(pool: &SqlitePool) {
        sqlx::raw_sql(
            r#"CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL,
                model_plan TEXT, model_brainstorm TEXT, model_execute TEXT, model_risk TEXT,
                model_review TEXT, model_session TEXT, model_qa TEXT, model_prd TEXT,
                "model_review-fixer" TEXT, model_retro TEXT, model_workflow TEXT,
                agent_runtime_plan TEXT, agent_runtime_prd TEXT, agent_runtime_execute TEXT,
                agent_runtime_risk TEXT, agent_runtime_review TEXT, "agent_runtime_review-fixer" TEXT,
                agent_runtime_session TEXT, agent_runtime_qa TEXT, agent_runtime_retro TEXT,
                agent_autonomy TEXT, parallel_execution TEXT DEFAULT NULL, qa_prompt TEXT
            );
            CREATE TABLE features (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
                title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', type TEXT NOT NULL DEFAULT 'feature',
                label TEXT, model_plan TEXT, model_brainstorm TEXT, model_execute TEXT, model_risk TEXT,
                model_review TEXT, model_session TEXT, model_qa TEXT, model_prd TEXT,
                "model_review-fixer" TEXT, model_retro TEXT, model_workflow TEXT, prd TEXT,
                workflow_step TEXT, workflow_config TEXT, workflow_status TEXT NOT NULL DEFAULT 'idle',
                agent_runtime_plan TEXT, agent_runtime_prd TEXT, agent_runtime_execute TEXT,
                agent_runtime_risk TEXT, agent_runtime_review TEXT, "agent_runtime_review-fixer" TEXT,
                agent_runtime_session TEXT, agent_runtime_qa TEXT, agent_runtime_retro TEXT,
                agent_autonomy TEXT, parallel_execution TEXT DEFAULT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE workflow_queue (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), agent_session_id INTEGER REFERENCES agent_sessions(id));
            CREATE TABLE workflow_dependencies (id INTEGER PRIMARY KEY, queue_item_id INTEGER NOT NULL REFERENCES workflow_queue(id), depends_on_item_id INTEGER NOT NULL REFERENCES workflow_queue(id));
            CREATE TABLE phases (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL);
            CREATE TABLE plans (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), pending_plan_approval TEXT, pending_prd_approval TEXT, plan_approval_result TEXT, prd_approval_result TEXT, run_id INTEGER, phase_id INTEGER, question_answer_result TEXT, is_pinned INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE session_runtime_ids (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id));
            -- content/message_type were in the real baseline at this era; the
            -- FTS narrowing migration (20260803122000) selects both by name.
            CREATE TABLE agent_messages (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES agent_sessions(id), role TEXT NOT NULL DEFAULT 'assistant', content TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT 'text', created_at TEXT NOT NULL DEFAULT (datetime('now')));
            CREATE TABLE feature_settings (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id), key TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE project_settings (project_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE diff_comments (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE TABLE diff_viewed_files (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE TABLE custom_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, command TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'global');
            CREATE TABLE custom_action_runs (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE TABLE custom_action_variables (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE TABLE custom_action_schedules (id INTEGER PRIMARY KEY, feature_id INTEGER NOT NULL REFERENCES features(id));
            CREATE INDEX idx_agent_sessions_feature_status ON agent_sessions(feature_id);"#,
        )
        .execute(pool)
        .await
        .unwrap();
    }
}
