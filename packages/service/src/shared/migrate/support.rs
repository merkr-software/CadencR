use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{AssertSqlSafe, Row, SqlitePool};

use crate::shared::startup_progress::{run_phase, StartupStep};

pub(super) async fn has_pending_migrations(
    pool: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<bool> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(true);
    }

    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations")
        .fetch_all(pool)
        .await?;
    let applied: HashSet<i64> = applied.into_iter().collect();
    for migration in migrator.iter() {
        if !applied.contains(&migration.version) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn is_upgrade_migration_pending(
    pool: &SqlitePool,
    version: i64,
) -> anyhow::Result<bool> {
    if !table_exists(pool, "_sqlx_migrations").await? {
        return Ok(false);
    }
    let applied: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ? AND success = TRUE",
    )
    .bind(version)
    .fetch_one(pool)
    .await?;
    Ok(applied == 0)
}

pub(crate) async fn table_exists(pool: &SqlitePool, table_name: &str) -> anyhow::Result<bool> {
    let count: i32 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?")
            .bind(table_name)
            .fetch_one(pool)
            .await?;
    Ok(count > 0)
}

pub(super) async fn table_columns(
    pool: &SqlitePool,
    table_name: &str,
) -> anyhow::Result<HashSet<String>> {
    let escaped_table = table_name.replace('"', "\"\"");
    let rows = sqlx::query(AssertSqlSafe(format!(
        r#"PRAGMA table_info("{escaped_table}")"#
    )))
    .fetch_all(pool)
    .await?;
    let mut columns = HashSet::new();
    for row in rows {
        let name: String = row.try_get("name")?;
        columns.insert(name);
    }
    Ok(columns)
}

pub(super) async fn table_has_column(
    pool: &SqlitePool,
    table_name: &str,
    column_name: &str,
) -> anyhow::Result<bool> {
    Ok(table_columns(pool, table_name).await?.contains(column_name))
}

/// Fail before `VACUUM INTO` if the volume can't hold another copy.
///
/// Without this the snapshot runs until SQLite returns `SQLITE_FULL`, which
/// reads as "the backup failed" — indistinguishable from a permissions problem
/// and reported after minutes of I/O. Checking up front turns it into an
/// actionable message. The margin is the database's own size plus a little
/// headroom: the migration that follows also needs WAL space.
fn ensure_room_for_backup(db_bytes: u64, dir: &Path) -> anyhow::Result<()> {
    let Some(available) = crate::shared::disk_space::available_bytes(dir) else {
        // No answer from the platform is not a reason to block a launch; the
        // VACUUM will surface a real failure if there genuinely is no room.
        return Ok(());
    };
    let needed = db_bytes.saturating_add(db_bytes / 10);
    if available < needed {
        anyhow::bail!(
            "not enough free disk space for a pre-migration backup: {} available, {} needed in {}",
            crate::shared::disk_space::human_bytes(available),
            crate::shared::disk_space::human_bytes(needed),
            dir.display()
        );
    }
    Ok(())
}

pub(super) async fn backup_database(
    pool: &SqlitePool,
    db_path: &Path,
    app_version: Option<&str>,
) -> anyhow::Result<Option<PathBuf>> {
    if !db_path.is_file() {
        return Ok(None);
    }
    let dir = db_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("db path has no parent directory: {}", db_path.display()))?;
    // Falling back to a literal like "unknown" would file every snapshot taken
    // outside a packaged build under one synthetic version, and rotation keeps
    // the newest snapshot *per version* — so the whole history would collapse to
    // a single file. The crate version is the honest answer and keeps versions
    // distinct.
    let version = app_version.unwrap_or(env!("CARGO_PKG_VERSION"));
    let timestamp = format!(
        "{}-{}",
        chrono::Local::now().format("%Y-%m-%d-%H-%M-%S"),
        uuid::Uuid::new_v4().simple()
    );
    let name = super::backup_rotation::naming::backup_file_name(db_path, version, &timestamp)
        .ok_or_else(|| anyhow::anyhow!("unsafe database backup name or app version: {version}"))?;
    let backup = dir.join(&name);

    // `VACUUM INTO` produces a single consistent snapshot that includes
    // anything pending in the WAL; a plain file copy of the `.db` would miss
    // uncommitted data in the `.db-wal` sibling.
    // One stable path bounds failed backup storage to a single preserved copy.
    // SQLite creates the destination exclusively, so concurrent startups never
    // overwrite or remove each other's in-progress snapshot.
    let identity = super::backup_rotation::naming::database_identity(db_path)
        .ok_or_else(|| anyhow::anyhow!("database path has no safe backup identity"))?;
    let staging = dir.join(format!(".{identity}.cadencr.backup.partial"));
    if staging.try_exists()? {
        anyhow::bail!(
            "an unfinished pre-migration backup already exists; refusing to overwrite it: {}",
            staging.display()
        );
    }
    let db_bytes = std::fs::metadata(db_path)?.len();
    ensure_room_for_backup(db_bytes, dir)?;

    let staging_str = staging
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("backup path is not valid UTF-8: {}", staging.display()))?;
    run_phase(
        StartupStep::CreateBackup { bytes: db_bytes },
        sqlx::query("VACUUM INTO ?").bind(staging_str).execute(pool),
    )
    .await?;
    std::fs::File::open(&staging)?.sync_all()?;
    validate_backup(&staging).await?;
    std::fs::rename(&staging, &backup)?;
    crate::shared::fs_durability::sync_directory(dir)?;
    Ok(Some(backup))
}

async fn validate_backup(path: &Path) -> anyhow::Result<()> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() == 0 {
        anyhow::bail!("pre-migration backup is not a non-empty regular file");
    }
    let options = SqliteConnectOptions::new().filename(path).read_only(true);
    let validation_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let validation = crate::shared::db::run_quick_check(&validation_pool).await;
    validation_pool.close().await;
    validation?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn special_upgrade_copy_requires_an_existing_migration_history() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        assert!(!is_upgrade_migration_pending(&pool, 42).await.unwrap());

        sqlx::query(
            "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, success BOOLEAN NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(is_upgrade_migration_pending(&pool, 42).await.unwrap());

        sqlx::query("INSERT INTO _sqlx_migrations (version, success) VALUES (42, TRUE)")
            .execute(&pool)
            .await
            .unwrap();
        assert!(!is_upgrade_migration_pending(&pool, 42).await.unwrap());
    }

    #[tokio::test]
    async fn unsafe_version_is_rejected_before_vacuum() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("source.db");
        let database_url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sample (value) VALUES ('preserved')")
            .execute(&pool)
            .await
            .unwrap();

        let error = backup_database(&pool, &db_path, Some("v'quoted"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unsafe database backup name"));
    }

    #[tokio::test]
    async fn repeated_backups_use_distinct_validated_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("source.db");
        let database_url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample (value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sample (value) VALUES ('preserved')")
            .execute(&pool)
            .await
            .unwrap();

        let first = backup_database(&pool, &db_path, Some("0.11.0"))
            .await
            .unwrap()
            .unwrap();
        let second = backup_database(&pool, &db_path, Some("0.11.0"))
            .await
            .unwrap()
            .unwrap();

        assert_ne!(first, second);
        validate_backup(&first).await.unwrap();
        validate_backup(&second).await.unwrap();
        assert_eq!(
            super::super::backup_rotation::naming::source_database_file_name(&first).as_deref(),
            Some("source.db")
        );
        assert_eq!(
            super::super::backup_rotation::naming::source_database_file_name(&second).as_deref(),
            Some("source.db")
        );
    }

    #[tokio::test]
    async fn invalid_snapshot_is_rejected_without_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        let invalid = dir.path().join("invalid.partial");
        std::fs::write(&invalid, b"not a sqlite database").unwrap();

        assert!(validate_backup(&invalid).await.is_err());
        assert_eq!(std::fs::read(&invalid).unwrap(), b"not a sqlite database");
    }

    #[tokio::test]
    async fn unfinished_backup_is_preserved_and_blocks_retries() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("source.db");
        let database_url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample (value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let identity = super::super::backup_rotation::naming::database_identity(&db_path).unwrap();
        let staging = dir
            .path()
            .join(format!(".{identity}.cadencr.backup.partial"));
        std::fs::write(&staging, b"preserved partial backup").unwrap();

        let error = backup_database(&pool, &db_path, Some("0.11.0"))
            .await
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("unfinished pre-migration backup"));
        assert_eq!(
            std::fs::read(&staging).unwrap(),
            b"preserved partial backup"
        );
    }
}
