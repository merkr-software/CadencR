use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::*;
use crate::domain::git::repository;
use crate::domain::git::workflow_service;
use crate::domain::git::worktree_context::{
    build_worktree_context, resolve_source_git_root, WorktreeContext,
};
use crate::error::AppError;

use super::{
    migrate_provider_config_for_context, normalize_git_path, SETTING_WORKTREE_BRANCH,
    SETTING_WORKTREE_PATH,
};

pub async fn get_worktree_info(
    state: &AppState,
    params: WorktreeInfoParams,
) -> Result<Option<WorktreeInfo>, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let wt_path =
        repository::get_feature_setting(&state.read_pool, params.feature_id, SETTING_WORKTREE_PATH)
            .await?;
    let wt_path = match wt_path {
        Some(p) => p,
        None => return Ok(None),
    };
    commands::get_worktree_info(Path::new(&project_path), Path::new(&wt_path)).await
}

pub async fn create_worktree(
    state: &AppState,
    body: CreateWorktreeBody,
) -> Result<CreateWorktreeResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, body.project_id).await?;
    let project_name = repository::get_project_name(&state.read_pool, body.project_id).await?;
    let prefix = repository::get_branch_prefix(&state.read_pool, body.project_id).await?;
    let branch_name = commands::build_branch_name(&prefix, &body.feature_title);

    let (context, branch) =
        create_and_migrate_worktree(&project_path, &project_name, &branch_name).await?;
    let session_cwd_str = context.session_cwd.to_string_lossy().to_string();

    repository::set_feature_setting(
        &state.write_pool,
        body.feature_id,
        SETTING_WORKTREE_PATH,
        &session_cwd_str,
    )
    .await?;
    repository::set_feature_setting(
        &state.write_pool,
        body.feature_id,
        SETTING_WORKTREE_BRANCH,
        &branch,
    )
    .await?;

    // TODO: Run project_settings.setup_worktree commands (e.g. `pnpm install`) after creating the worktree.
    // The legacy Electron code runs these as a separate background step via GitWorktree service.
    // This needs to be implemented here to match the legacy behavior.

    Ok(CreateWorktreeResponse {
        worktree_path: session_cwd_str,
        branch,
    })
}

pub async fn remove_worktree(
    state: &AppState,
    params: RemoveWorktreeParams,
) -> Result<SuccessResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let wt_path =
        repository::get_feature_setting(&state.read_pool, params.feature_id, SETTING_WORKTREE_PATH)
            .await?
            .ok_or_else(|| AppError::NotFound("No worktree found for this feature".into()))?;

    if is_default_worktree_path(&project_path, &wt_path) {
        return Ok(default_worktree_blocked());
    }

    commands::remove_worktree(Path::new(&project_path), Path::new(&wt_path), true).await?;
    repository::delete_feature_settings(
        &state.write_pool,
        params.feature_id,
        &[SETTING_WORKTREE_PATH],
    )
    .await?;

    Ok(SuccessResponse {
        success: true,
        error: None,
        blocked_reason: None,
    })
}

pub async fn delete_worktree(
    state: &AppState,
    params: DeleteWorktreeParams,
) -> Result<SuccessResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let wt_path =
        repository::get_feature_setting(&state.read_pool, params.feature_id, SETTING_WORKTREE_PATH)
            .await?
            .ok_or_else(|| AppError::NotFound("No worktree found for this feature".into()))?;

    if is_default_worktree_path(&project_path, &wt_path) {
        return Ok(default_worktree_blocked());
    }

    match commands::remove_worktree(Path::new(&project_path), Path::new(&wt_path), params.force)
        .await
    {
        Ok(_) => {
            repository::delete_feature_settings(
                &state.write_pool,
                params.feature_id,
                &[SETTING_WORKTREE_PATH],
            )
            .await?;
            Ok(SuccessResponse {
                success: true,
                error: None,
                blocked_reason: None,
            })
        }
        Err(e) if !params.force && is_dirty_worktree_remove_error(&e) => {
            Ok(dirty_worktree_response())
        }
        Err(e) => Ok(error_response(e)),
    }
}

pub async fn retry_worktree_setup(
    state: &AppState,
    body: RetryWorktreeBody,
) -> Result<SuccessResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, body.project_id).await?;
    let project_name = repository::get_project_name(&state.read_pool, body.project_id).await?;

    // Reuse stored branch name to avoid creating duplicate worktrees
    let branch_name = match repository::get_feature_setting(
        &state.read_pool,
        body.feature_id,
        SETTING_WORKTREE_BRANCH,
    )
    .await?
    {
        Some(existing) => existing,
        None => {
            let prefix = repository::get_branch_prefix(&state.read_pool, body.project_id).await?;
            let title = repository::get_feature_title(&state.read_pool, body.feature_id)
                .await?
                .unwrap_or_else(|| "feature".to_string());
            commands::build_branch_name(&prefix, &title)
        }
    };

    let (context, branch) =
        create_and_migrate_worktree(&project_path, &project_name, &branch_name).await?;
    let session_cwd_str = context.session_cwd.to_string_lossy().to_string();

    repository::set_feature_setting(
        &state.write_pool,
        body.feature_id,
        SETTING_WORKTREE_PATH,
        &session_cwd_str,
    )
    .await?;
    repository::set_feature_setting(
        &state.write_pool,
        body.feature_id,
        SETTING_WORKTREE_BRANCH,
        &branch,
    )
    .await?;

    Ok(SuccessResponse {
        success: true,
        error: None,
        blocked_reason: None,
    })
}

pub async fn list_project_worktrees(
    state: &AppState,
    params: ListProjectWorktreesParams,
) -> Result<Vec<ProjectWorktreeInfo>, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let worktrees = commands::list_worktrees(Path::new(&project_path))
        .await
        .unwrap_or_default();

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
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let default_branch = if rows.iter().any(|row| row.worktree_branch.is_some()) {
        Some(workflow_service::resolve_default_branch(Path::new(&project_path)).await?)
    } else {
        None
    };

    // Probe disk presence concurrently — otherwise we'd serialize one syscall
    // per feature inside a hot async handler.
    let liveness = futures::future::join_all(
        rows.iter()
            .map(|r| async { tokio::fs::metadata(&r.worktree_path).await.is_ok() }),
    )
    .await;

    Ok(rows
        .into_iter()
        .zip(liveness)
        .map(|(r, live)| {
            let is_main_worktree = is_default_worktree_path(&project_path, &r.worktree_path);
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
                live,
            }
        })
        .collect())
}

pub async fn remove_orphan_worktree(
    state: &AppState,
    body: RemoveOrphanWorktreeBody,
) -> Result<SuccessResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, body.project_id).await?;
    if is_default_worktree_path(&project_path, &body.worktree_path) {
        return Ok(default_worktree_blocked());
    }
    match commands::remove_worktree(
        Path::new(&project_path),
        Path::new(&body.worktree_path),
        body.force,
    )
    .await
    {
        Ok(_) => Ok(SuccessResponse {
            success: true,
            error: None,
            blocked_reason: None,
        }),
        Err(e) if !body.force && is_dirty_worktree_remove_error(&e) => {
            Ok(dirty_worktree_response())
        }
        Err(e) => Ok(error_response(e)),
    }
}

fn default_worktree_blocked() -> SuccessResponse {
    SuccessResponse {
        success: false,
        error: Some("Cannot remove the default worktree".to_string()),
        blocked_reason: Some("default_worktree".to_string()),
    }
}

fn is_default_worktree_path(project_path: &str, worktree_path: &str) -> bool {
    normalize_git_path(project_path) == normalize_git_path(worktree_path)
}

async fn create_and_migrate_worktree(
    project_path: &str,
    project_name: &str,
    branch_name: &str,
) -> Result<(WorktreeContext, String), AppError> {
    let selected_project_path = Path::new(project_path);
    let source_root = resolve_source_git_root(selected_project_path)
        .await
        .map_err(AppError::Internal)?;
    let (worktree_root, branch) =
        commands::create_worktree(&source_root, branch_name, project_name).await?;
    let context = build_worktree_context(
        &source_root,
        selected_project_path,
        Path::new(&worktree_root),
    )
    .map_err(AppError::Internal)?;
    migrate_provider_config_for_context(&context).await?;
    Ok((context, branch))
}

pub(super) fn dirty_worktree_response() -> SuccessResponse {
    SuccessResponse {
        success: false,
        error: Some("Worktree has uncommitted or untracked changes".into()),
        blocked_reason: Some("dirty_worktree".into()),
    }
}

pub(super) fn error_response(err: AppError) -> SuccessResponse {
    SuccessResponse {
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
