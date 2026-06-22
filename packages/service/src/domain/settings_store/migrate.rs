//! One-time, idempotent, non-destructive migration of settings from SQLite into
//! JSON files.
//!
//! Safety properties:
//! - **Idempotent:** a target file is only written when it does not already
//!   exist, so re-running never overwrites JSON the user (or a prior run) wrote.
//! - **Non-destructive:** the source SQLite rows/columns are read but never
//!   modified or dropped — they remain as a backup.
//! - **Best-effort:** any per-item failure is collected as a warning and logged;
//!   migration never blocks startup.

use std::collections::BTreeMap;
use std::path::Path;

use sqlx::{AssertSqlSafe, SqlitePool};
use tracing::{info, warn};

use super::{ephemeral, file, paths};

/// Project columns that historically held settings (mirrors the real columns in
/// `projects::repository::set_project_setting`).
const PROJECT_COLUMNS: &[&str] = &["branch_prefix", "model_session", "agent_runtime_session"];

#[derive(Debug, Default)]
pub struct MigrationSummary {
    pub migrated_global: bool,
    pub migrated_projects: usize,
    pub warnings: Vec<String>,
}

/// Migrate global + project settings from SQLite into JSON files under `dir`.
pub async fn migrate_from_sqlite(pool: &SqlitePool, dir: &Path) -> MigrationSummary {
    let mut summary = MigrationSummary::default();

    match migrate_global(pool, dir).await {
        Ok(true) => summary.migrated_global = true,
        Ok(false) => {}
        Err(e) => summary.warnings.push(format!("global settings: {e}")),
    }

    match migrate_projects(pool, dir).await {
        Ok(count) => summary.migrated_projects = count,
        Err(e) => summary.warnings.push(format!("project settings: {e}")),
    }

    if summary.migrated_global || summary.migrated_projects > 0 {
        info!(
            global = summary.migrated_global,
            projects = summary.migrated_projects,
            "migrated settings from SQLite to JSON files"
        );
    }
    for w in &summary.warnings {
        warn!("settings migration warning: {w}");
    }
    summary
}

async fn migrate_global(pool: &SqlitePool, dir: &Path) -> Result<bool, String> {
    let target = paths::global_file(dir);
    if target.exists() {
        return Ok(false);
    }

    let rows = sqlx::query_as::<_, (String, Option<String>)>("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    // Skip per-device UI state — it now lives in the frontend's localStorage,
    // never in the settings files.
    let map: BTreeMap<String, String> = rows
        .into_iter()
        .filter(|(k, _)| !ephemeral::is_ephemeral_key(k))
        .filter_map(|(k, v)| v.map(|value| (k, value)))
        .collect();

    file::write_atomic(&target, &file::serialize_map(&map)).map_err(|e| e.to_string())?;
    Ok(true)
}

async fn migrate_projects(pool: &SqlitePool, dir: &Path) -> Result<usize, String> {
    let ids = sqlx::query_as::<_, (i64,)>("SELECT id FROM projects")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut migrated = 0;
    for (id,) in ids {
        match migrate_project(pool, dir, id).await {
            Ok(true) => migrated += 1,
            Ok(false) => {}
            Err(e) => warn!("settings migration: project {id}: {e}"),
        }
    }
    Ok(migrated)
}

async fn migrate_project(pool: &SqlitePool, dir: &Path, project_id: i64) -> Result<bool, String> {
    let target = paths::project_file(dir, pool, project_id)
        .await
        .map_err(|e| e.to_string())?;
    if target.exists() {
        return Ok(false);
    }

    let mut map = BTreeMap::new();

    // Real columns on `projects`.
    for column in PROJECT_COLUMNS {
        let sql = format!("SELECT \"{column}\" FROM projects WHERE id = ?");
        let value = sqlx::query_as::<_, (Option<String>,)>(AssertSqlSafe(sql))
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|(v,)| v)
            .filter(|v| !v.is_empty());
        if let Some(value) = value {
            map.insert((*column).to_string(), value);
        }
    }

    // EAV rows.
    let rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT key, value FROM project_settings WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for (key, value) in rows {
        if let Some(value) = value {
            map.insert(key, value);
        }
    }

    // Nothing to migrate → leave no file (a settings-less project never needs
    // one; the UI creates it lazily on first write).
    if map.is_empty() {
        return Ok(false);
    }

    file::write_atomic(&target, &file::serialize_map(&map)).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn seed_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '', branch_prefix TEXT, model_session TEXT, agent_runtime_session TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE project_settings (project_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(project_id, key))")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn migrates_global_and_project_settings() {
        let pool = seed_pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('theme_current', 'tokyo-night'), ('editor_auto_save', 'false')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects (id, name, branch_prefix) VALUES (1, 'Alpha', 'fr/')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO project_settings (project_id, key, value) VALUES (1, 'setup_worktree', 'pnpm install')")
            .execute(&pool).await.unwrap();

        let dir = tempfile::tempdir().unwrap();
        let summary = migrate_from_sqlite(&pool, dir.path()).await;
        assert!(summary.migrated_global);
        assert_eq!(summary.migrated_projects, 1);

        let (global, _) = super::super::store::load(
            &paths::global_file(dir.path()),
            super::super::Scope::Workspace,
        );
        assert_eq!(
            global.get("theme_current").map(String::as_str),
            Some("tokyo-night")
        );

        let ppath = paths::project_file(dir.path(), &pool, 1).await.unwrap();
        let (proj, _) = super::super::store::load(&ppath, super::super::Scope::Project);
        assert_eq!(proj.get("branch_prefix").map(String::as_str), Some("fr/"));
        assert_eq!(
            proj.get("setup_worktree").map(String::as_str),
            Some("pnpm install")
        );
    }

    #[tokio::test]
    async fn is_idempotent_and_non_destructive() {
        let pool = seed_pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('theme_current', 'tokyo-night')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();

        let first = migrate_from_sqlite(&pool, dir.path()).await;
        assert!(first.migrated_global);

        // User edits the JSON after migration.
        let global = paths::global_file(dir.path());
        std::fs::write(&global, r#"{"theme_current":"catppuccin"}"#).unwrap();

        // Re-running must NOT overwrite the user's edit.
        let second = migrate_from_sqlite(&pool, dir.path()).await;
        assert!(!second.migrated_global);
        let text = std::fs::read_to_string(&global).unwrap();
        assert!(text.contains("catppuccin"));

        // Source rows are untouched.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn skips_ephemeral_ui_keys() {
        let pool = seed_pool().await;
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES \
             ('theme_current', 'tokyo-night'), \
             ('active_tab_1', 'browser'), \
             ('editor_sidebar_visible_2', 'true'), \
             ('lastOpenedFeature', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let dir = tempfile::tempdir().unwrap();
        migrate_from_sqlite(&pool, dir.path()).await;

        let (global, _) = super::super::store::load(
            &paths::global_file(dir.path()),
            super::super::Scope::Workspace,
        );
        // Real config migrates; ephemeral per-device keys are dropped.
        assert_eq!(
            global.get("theme_current").map(String::as_str),
            Some("tokyo-night")
        );
        assert!(!global.contains_key("active_tab_1"));
        assert!(!global.contains_key("editor_sidebar_visible_2"));
        assert!(!global.contains_key("lastOpenedFeature"));
    }

    #[tokio::test]
    async fn settingless_project_creates_no_file() {
        let pool = seed_pool().await;
        sqlx::query("INSERT INTO projects (id, name) VALUES (1, 'Empty')")
            .execute(&pool)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let summary = migrate_from_sqlite(&pool, dir.path()).await;
        assert_eq!(summary.migrated_projects, 0);
        let ppath = paths::project_file(dir.path(), &pool, 1).await.unwrap();
        assert!(!ppath.exists());
    }
}
