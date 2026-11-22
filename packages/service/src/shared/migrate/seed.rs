//! Schema seeding for legacy databases and repair of columns sqlx skipped.
//!
//! Split from `mod.rs` to keep that file focused on the run-once orchestration
//! and to honor the project's 400-line file cap.

use sqlx::SqlitePool;
use tracing::info;

use super::support::{table_columns, table_exists, table_has_column};

/// Seed the `_sqlx_migrations` table so sqlx considers existing migrations already applied.
/// One-time operation for databases originally created by the Electron migration runner.
pub(super) async fn seed_sqlx_migrations(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    if table_exists(pool, "_sqlx_migrations").await? {
        return Ok(());
    }

    info!("Existing database detected — seeding sqlx migration history");

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
    .await?;

    for migration in migrator.iter() {
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time)
             VALUES (?, ?, CURRENT_TIMESTAMP, TRUE, ?, 0)",
        )
        .bind(migration.version)
        .bind(&*migration.description)
        .bind(&*migration.checksum)
        .execute(pool)
        .await?;
    }

    info!(
        "Seeded {} migration(s) into _sqlx_migrations",
        migrator.iter().count()
    );
    Ok(())
}

/// Repair dev-era/minimal legacy schemas before migrations that build FTS over
/// `agent_messages.content`. The canonical baseline has this column, but some
/// historical fixtures and hand-edited dev DBs may not.
pub(super) async fn repair_agent_messages_content_column(pool: &SqlitePool) -> anyhow::Result<()> {
    if !table_exists(pool, "agent_messages").await? {
        return Ok(());
    }
    if !table_has_column(pool, "agent_messages", "content").await? {
        info!("Repairing missing agent_messages.content column");
        sqlx::query("ALTER TABLE agent_messages ADD COLUMN content TEXT NOT NULL DEFAULT ''")
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Backfill revision tracking for databases imported from the legacy Electron
/// migration runner. Its history is seeded as applied, so newly embedded sqlx
/// migrations do not run against those databases.
pub(super) async fn repair_agent_message_content_revisions(
    pool: &SqlitePool,
) -> anyhow::Result<()> {
    if !table_exists(pool, "agent_sessions").await? || !table_exists(pool, "agent_messages").await?
    {
        return Ok(());
    }

    if !table_has_column(pool, "agent_sessions", "message_revision").await? {
        sqlx::query(
            "ALTER TABLE agent_sessions
             ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0",
        )
        .execute(pool)
        .await?;
    }
    if !table_has_column(pool, "agent_messages", "content_revision").await? {
        sqlx::query(
            "ALTER TABLE agent_messages
             ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0",
        )
        .execute(pool)
        .await?;
    }

    if table_has_column(pool, "agent_messages", "content").await?
        && table_has_column(pool, "agent_messages", "message_type").await?
        && table_has_column(pool, "agent_messages", "session_id").await?
    {
        sqlx::raw_sql(
            "DROP TRIGGER IF EXISTS agent_messages_content_revision;
             CREATE TRIGGER agent_messages_content_revision
             AFTER UPDATE OF content ON agent_messages
             WHEN NEW.content IS NOT OLD.content
              AND NEW.message_type = 'tool_call'
             BEGIN
                 UPDATE agent_sessions
                 SET message_revision = message_revision + 1
                 WHERE id = NEW.session_id;

                 UPDATE agent_messages
                 SET content_revision = (
                     SELECT message_revision FROM agent_sessions WHERE id = NEW.session_id
                 )
                 WHERE id = NEW.id;
             END;",
        )
        .execute(pool)
        .await?;
    }

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_content_revision
         ON agent_messages(session_id, content_revision)
         WHERE content_revision > 0",
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub(super) async fn repair_agent_messages_perf_indexes(pool: &SqlitePool) -> anyhow::Result<()> {
    if !table_exists(pool, "agent_messages").await? {
        return Ok(());
    }

    // Legacy Electron-runner databases can have their sqlx migration history
    // seeded as already-applied, so the SQL migration that owns these indexes
    // may be skipped. Keep this as a compatibility repair, not schema source
    // of truth; fresh databases get the same indexes from the migration file.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id_desc
         ON agent_messages(session_id, id DESC)",
    )
    .execute(pool)
    .await?;

    let message_columns = table_columns(pool, "agent_messages").await?;

    if message_columns.contains("message_type") && message_columns.contains("tool_name") {
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_type_tool
             ON agent_messages(session_id, message_type, tool_name)",
        )
        .execute(pool)
        .await?;
    }

    if message_columns.contains("tool_use_id") {
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_tool_use
             ON agent_messages(session_id, tool_use_id)",
        )
        .execute(pool)
        .await?;
    }

    if message_columns.contains("role") && message_columns.contains("created_at") {
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_role_created
             ON agent_messages(session_id, role, created_at)",
        )
        .execute(pool)
        .await?;
    }

    if table_exists(pool, "features").await? {
        let feature_columns = table_columns(pool, "features").await?;
        if feature_columns.contains("project_id") && feature_columns.contains("status") {
            sqlx::query(
                "CREATE INDEX IF NOT EXISTS idx_features_project_status
                 ON features(project_id, status)",
            )
            .execute(pool)
            .await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{run_migrations, MigrationContext};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
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
    async fn test_existing_db_seeding() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_str().unwrap();
        let pool = test_pool(path).await;

        sqlx::query(
            "CREATE TABLE migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO migrations (version, description) VALUES (48, 'latest')")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        let count: i32 =
            sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = TRUE")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(count >= 1);

        let old_count: i32 = sqlx::query_scalar("SELECT COUNT(*) FROM migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(old_count, 1);
    }

    #[tokio::test]
    async fn legacy_database_gets_content_revision_tracking() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TABLE migrations (version INTEGER PRIMARY KEY);
             CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY);
             CREATE TABLE agent_messages (
                 id INTEGER PRIMARY KEY,
                 session_id INTEGER NOT NULL,
                 content TEXT NOT NULL,
                 message_type TEXT NOT NULL
             );
             INSERT INTO agent_sessions (id) VALUES (1);
             INSERT INTO agent_messages (id, session_id, content, message_type)
             VALUES (10, 1, 'before', 'tool_call'),
                    (11, 1, 'before', 'assistant_message');",
        )
        .execute(&pool)
        .await
        .unwrap();

        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();

        sqlx::query("UPDATE agent_messages SET content = 'ignored' WHERE id = 11")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE agent_messages SET content = 'after' WHERE id = 10")
            .execute(&pool)
            .await
            .unwrap();

        let session_revision: i64 =
            sqlx::query_scalar("SELECT message_revision FROM agent_sessions WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        let revisions: Vec<i64> =
            sqlx::query_scalar("SELECT content_revision FROM agent_messages ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(session_revision, 1);
        assert_eq!(revisions, vec![1, 0]);
    }
}
