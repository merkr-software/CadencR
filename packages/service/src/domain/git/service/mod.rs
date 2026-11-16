use std::path::Path;

use crate::app_state::AppState;
use crate::domain::features::service::ensure_belongs_to_project as ensure_feature_belongs_to_project;
use crate::domain::git::repository;
use crate::domain::git::worktree_context::WorktreeContext;
use crate::error::AppError;

mod blame;
mod branch;
mod diff;
mod feature_branch;
mod git_dir;
mod graph;
mod image;
mod stash;
mod worktree;
mod worktree_list;

pub use blame::*;
pub use branch::*;
pub use diff::*;
pub use feature_branch::*;
pub use git_dir::*;
pub use graph::*;
pub use image::*;
pub use stash::*;
pub use worktree::*;
pub use worktree_list::*;

// ---------------------------------------------------------------------------
// Feature-setting key constants
// ---------------------------------------------------------------------------

pub(crate) const SETTING_WORKTREE_PATH: &str = "worktree_path";
pub(super) const SETTING_WORKTREE_BRANCH: &str = "worktree_branch";
/// Branch created by the worktree-free "From branch" flow. Separate from
/// `worktree_branch` because the UI reads that key as "this feature has a
/// worktree" — see [`feature_branch`].
pub const SETTING_FEATURE_BRANCH: &str = "feature_branch";
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
    .map_err(|e| AppError::internal(e.to_string()))
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

pub(super) fn dirty_worktree_response() -> crate::domain::git::models::SuccessResponse {
    crate::domain::git::models::SuccessResponse {
        success: false,
        error: Some("Worktree has uncommitted or untracked changes".into()),
        blocked_reason: Some("dirty_worktree".into()),
    }
}

pub(super) fn error_response(err: AppError) -> crate::domain::git::models::SuccessResponse {
    crate::domain::git::models::SuccessResponse {
        success: false,
        error: Some(err.to_string()),
        blocked_reason: None,
    }
}

pub(super) fn is_dirty_worktree_remove_error(err: &AppError) -> bool {
    let message = err.to_string();
    message.contains("contains modified or untracked files")
        || message.contains("has local modifications")
        || message.contains("use --force")
}

/// Resolve the working directory, including for projects without Git. See
/// [`crate::domain::git::feature_dir`] for the liveness and fallback rules.
pub async fn resolve_feature_working_path(
    state: &AppState,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    Ok(
        crate::domain::git::feature_dir::resolve_feature_dir(&state.read_pool, feature_id)
            .await?
            .map(|dir| dir.cwd),
    )
}

/// Helper to get project path + the feature's own branch for
/// merge/conflict/delete operations.
///
/// Deliberately only the *recorded* branch: these operations delete and merge
/// refs, so a feature that merely follows whatever the project has checked out
/// ("On branch" mode) must keep erroring rather than offering to delete the
/// branch the user is standing on.
pub(super) async fn get_project_and_branch(
    state: &AppState,
    project_id: i64,
    feature_id: i64,
) -> Result<(String, String), AppError> {
    let project_path = repository::get_project_path(&state.read_pool, project_id).await?;
    let branch = feature_branch::recorded_feature_branch(&state.read_pool, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound("No branch recorded for this feature".into()))?;
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
        sqlx::query(crate::domain::git::linked_branches::repository::TEST_SCHEMA)
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn feature_project_guard_rejects_mismatched_project() {
        let pool = test_support::setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 7, 'feature')")
            .execute(&pool)
            .await
            .unwrap();

        ensure_feature_belongs_to_project(&pool, 1, 7)
            .await
            .unwrap();
        assert!(matches!(
            ensure_feature_belongs_to_project(&pool, 1, 8).await,
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            ensure_feature_belongs_to_project(&pool, 999, 7).await,
            Err(AppError::NotFound(_))
        ));
    }
}
