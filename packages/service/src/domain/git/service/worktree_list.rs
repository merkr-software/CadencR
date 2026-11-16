use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::models::{
    FeatureWorktreeInfo, ListFeatureWorktreesParams, ListProjectWorktreesParams,
    ProjectWorktreeInfo,
};
use crate::domain::git::{commands, repository, workflow_service};
use crate::error::AppError;

use super::worktree::is_default_worktree_path;

pub async fn list_project_worktrees(
    state: &AppState,
    params: ListProjectWorktreesParams,
) -> Result<Vec<ProjectWorktreeInfo>, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    if !crate::shared::git_context::has_git_metadata(Path::new(&project_path)).await? {
        return Ok(Vec::new());
    }
    let worktrees = commands::list_worktrees(Path::new(&project_path)).await?;

    let repo_root_canonical = std::fs::canonicalize(&project_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&project_path));
    let repo_root_str = repo_root_canonical
        .to_string_lossy()
        .trim_end_matches('/')
        .to_string();
    let secondary: Vec<_> = worktrees
        .into_iter()
        .filter(|w| {
            let w_canonical = std::fs::canonicalize(&w.path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&w.path));
            w_canonical.to_string_lossy().trim_end_matches('/') != repo_root_str && !w.is_bare
        })
        .collect();

    let feature_lookup =
        repository::get_worktree_feature_lookup(&state.read_pool, params.project_id).await?;
    // Build lookup by canonicalized path for symlink-safe matching
    let by_path: std::collections::HashMap<String, _> = feature_lookup
        .iter()
        .map(|r| {
            let canonical = std::fs::canonicalize(&r.worktree_path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&r.worktree_path));
            (canonical.to_string_lossy().to_string(), r)
        })
        .collect();

    Ok(secondary
        .into_iter()
        .map(|w| {
            let w_canonical = std::fs::canonicalize(&w.path)
                .unwrap_or_else(|_| std::path::PathBuf::from(&w.path));
            let feat = by_path.get(&*w_canonical.to_string_lossy());
            ProjectWorktreeInfo {
                path: w.path,
                branch: w.branch,
                head: w.head,
                feature_id: feat.map(|f| f.feature_id),
                feature_title: feat.map(|f| f.feature_title.clone()),
                feature_status: feat.map(|f| f.feature_status.clone()),
            }
        })
        .collect())
}

pub async fn list_feature_worktrees(
    state: &AppState,
    params: ListFeatureWorktreesParams,
) -> Result<Vec<FeatureWorktreeInfo>, AppError> {
    let rows =
        repository::list_feature_worktree_settings(&state.read_pool, params.project_id).await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    if !crate::shared::git_context::has_git_metadata(Path::new(&project_path)).await? {
        return Ok(Vec::new());
    }
    let has_recorded_branch = rows.iter().any(|row| row.worktree_branch.is_some());
    let registered_worktrees =
        commands::WorktreeRoots::new(commands::list_worktrees(Path::new(&project_path)).await?);
    let project_subpath = registered_worktrees.project_subpath(Path::new(&project_path));
    let (default_branch, local_branches) = if has_recorded_branch {
        let (default_branch, local_branches) = tokio::try_join!(
            workflow_service::resolve_default_branch(Path::new(&project_path)),
            commands::list_local_branches(Path::new(&project_path)),
        )?;
        (Some(default_branch), local_branches)
    } else {
        (None, std::collections::HashSet::new())
    };

    let health = futures::future::try_join_all(rows.iter().map(|row| async {
        let path = Path::new(&row.worktree_path);
        let directory_exists = match tokio::fs::metadata(path).await {
            Ok(metadata) => metadata.is_dir(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(AppError::internal(format!(
                    "Failed to inspect worktree path: {error}"
                )))
            }
        };
        let live = directory_exists
            && registered_worktrees
                .find_copy(path, &project_subpath)
                .is_some();
        Ok((directory_exists, live))
    }))
    .await?;

    Ok(rows
        .into_iter()
        .zip(health)
        .map(|(r, (directory_exists, live))| {
            let is_main_worktree = is_default_worktree_path(&project_path, &r.worktree_path);
            let branch_exists = r
                .worktree_branch
                .as_ref()
                .map(|branch| local_branches.contains(branch));
            FeatureWorktreeInfo {
                feature_id: r.feature_id,
                worktree_path: r.worktree_path,
                is_default_branch: r
                    .worktree_branch
                    .as_deref()
                    .zip(default_branch.as_deref())
                    .is_some_and(|(branch, default)| {
                        workflow_service::same_branch_identity(branch, default)
                    }),
                is_main_worktree,
                worktree_branch: r.worktree_branch,
                directory_exists,
                branch_exists,
                live,
            }
        })
        .collect())
}
