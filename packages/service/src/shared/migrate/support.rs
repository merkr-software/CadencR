use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::{AssertSqlSafe, Row, SqlitePool};

/// Marker line consumed by the Electron sidecar to drive the splash status.
/// One line, fixed prefix; keep the format stable - the parser in
/// `packages/desktop/electron/main/sidecar.ts::parsePhaseLine` matches it.
pub(super) fn emit_phase(name: &str, detail: &str) {
    if detail.is_empty() {
        println!("CADENCR_PHASE {name}");
    } else {
        println!("CADENCR_PHASE {name} {detail}");
    }
}

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

pub(super) async fn table_exists(pool: &SqlitePool, table_name: &str) -> anyhow::Result<bool> {
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
    let version = app_version.unwrap_or("unknown");
    let timestamp = chrono::Local::now().format("%Y-%m-%d-%H").to_string();
    let backup = dir.join(format!("{version}.{timestamp}.cadencr.backup.db"));
    if backup.exists() {
        return Ok(Some(backup));
    }

    // `VACUUM INTO` produces a single consistent snapshot that includes
    // anything pending in the WAL; a plain file copy of the `.db` would miss
    // uncommitted data in the `.db-wal` sibling.
    let staging = dir.join(format!("{version}.{timestamp}.cadencr.backup.db.partial"));
    if staging.exists() {
        std::fs::remove_file(&staging)?;
    }

    // SQLite requires a string literal for VACUUM INTO; the path components
    // are under our control and contain no quotes, so concatenation is safe.
    let staging_str = staging
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("backup path is not valid UTF-8: {}", staging.display()))?;
    sqlx::query(AssertSqlSafe(format!("VACUUM INTO '{staging_str}'")))
        .execute(pool)
        .await?;
    std::fs::rename(&staging, &backup)?;
    Ok(Some(backup))
}
