//! Schema seeding for legacy databases and repair of columns sqlx skipped.
//!
//! Split from `mod.rs` to keep that file focused on the run-once orchestration
//! and to honor the project's 400-line file cap.

use sqlx::SqlitePool;
use tracing::info;

use super::support::{table_exists, table_has_column};

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

    if table_has_column(pool, "agent_messages", "message_type").await?
        && table_has_column(pool, "agent_messages", "tool_name").await?
    {
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_type_tool
             ON agent_messages(session_id, message_type, tool_name)",
        )
        .execute(pool)
        .await?;
    }

    if table_has_column(pool, "agent_messages", "tool_use_id").await? {
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_tool_use
             ON agent_messages(session_id, tool_use_id)",
        )
        .execute(pool)
        .await?;
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
}
