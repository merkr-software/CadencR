use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::repository;
use crate::domain::git::worktree_context::WorktreeContext;
use crate::error::AppError;

mod blame;
mod branch;
mod diff;
mod graph;
mod worktree;

pub use blame::*;
pub use branch::*;
pub use diff::*;
pub use graph::*;
pub use worktree::*;

// ---------------------------------------------------------------------------
// Feature-setting key constants
// ---------------------------------------------------------------------------

pub(super) const SETTING_WORKTREE_PATH: &str = "worktree_path";
pub(super) const SETTING_WORKTREE_BRANCH: &str = "worktree_branch";
pub(super) const SETTING_TARGET_BRANCH: &str = "target_branch";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub(super) async fn migrate_provider_config_for_context(
    context: &WorktreeContext,
) -> Result<(), AppError> {
    notify_provider_config_created(&context.source_root, &context.worktree_root).await
}

async fn notify_provider_config_created(
    source_root: &Path,
    worktree_root: &Path,
) -> Result<(), AppError> {
    crate::domain::agents::providers::notify_worktree_created_for_all_providers(
        source_root,
        worktree_root,
    )
    .await
    .map_err(|e| AppError::Internal(e.to_string()))
}

/// Canonicalize a path for stable comparison (resolves symlinks, trims a
/// trailing separator), falling back to the raw path if canonicalization fails.
pub(super) fn normalize_git_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| std::path::PathBuf::from(path))
        .to_string_lossy()
        .trim_end_matches(std::path::MAIN_SEPARATOR)
        .to_string()
}

/// Resolve the git directory for a feature.
/// Uses worktree_path if available, otherwise project path.
pub async fn resolve_feature_git_path(
    state: &AppState,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    // Check worktree path first (applies to all feature types)
    let wt = repository::get_feature_setting(&state.read_pool, feature_id, SETTING_WORKTREE_PATH)
        .await?;
    if let Some(path) = wt {
        return Ok(Some(path));
    }

    // Fall back to project path
    let row = repository::get_feature_type_and_project(&state.read_pool, feature_id).await?;
    let project_id = match row {
        Some((pid, _)) => pid,
        None => return Ok(None),
    };
    match repository::get_project_path(&state.read_pool, project_id).await {
        Ok(p) => Ok(Some(p)),
        Err(_) => Ok(None),
    }
}

/// Helper to get project path + worktree branch for merge/conflict/delete operations.
pub(super) async fn get_project_and_branch(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
) -> Result<(String, String), AppError> {
    let project_path = repository::get_project_path(&state.read_pool, project_id).await?;
    let branch =
        repository::get_feature_setting(&state.read_pool, feature_id, SETTING_WORKTREE_BRANCH)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("No worktree branch found for this feature".into())
            })?;
    Ok((project_path, branch))
}

#[cfg(test)]
pub(super) mod test_support {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    pub async fn setup_diff_refs_schema() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT, branch_prefix TEXT DEFAULT 'feature/')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT, type TEXT NOT NULL DEFAULT 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }
}
