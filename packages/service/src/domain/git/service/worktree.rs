use std::path::Path;

use tracing::debug;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::*;
use crate::domain::git::repository;
use crate::domain::git::worktree_context::{
    build_worktree_context, resolve_source_git_root, WorktreeContext,
};
use crate::error::AppError;

use super::{
    dirty_worktree_response, ensure_feature_belongs_to_project, error_response,
    is_dirty_worktree_remove_error, migrate_provider_config_for_context, normalize_git_path,
    SETTING_WORKTREE_BRANCH, SETTING_WORKTREE_PATH,
};

pub async fn get_worktree_info(
    state: &AppState,
    params: WorktreeInfoParams,
) -> Result<Option<WorktreeInfo>, AppError> {
    ensure_feature_belongs_to_project(&state.read_pool, params.feature_id, params.project_id)
        .await?;
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let wt_path =
        repository::get_feature_setting(&state.read_pool, params.feature_id, SETTING_WORKTREE_PATH)
            .await?;
    let wt_path = match wt_path {
        Some(p) => p,
        None => return Ok(None),
    };
    if !crate::shared::git_context::has_git_metadata(Path::new(&project_path)).await? {
        return Ok(None);
    }
    commands::registered_worktree_for_feature_path(Path::new(&project_path), Path::new(&wt_path))
        .await
}

pub async fn create_worktree(
    state: &AppState,
    body: CreateWorktreeBody,
) -> Result<CreateWorktreeResponse, AppError> {
    ensure_feature_belongs_to_project(&state.read_pool, body.feature_id, body.project_id).await?;
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
    ensure_feature_belongs_to_project(&state.read_pool, params.feature_id, params.project_id)
        .await?;
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
    ensure_feature_belongs_to_project(&state.read_pool, params.feature_id, params.project_id)
        .await?;
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let wt_path =
        repository::get_feature_setting(&state.read_pool, params.feature_id, SETTING_WORKTREE_PATH)
            .await?
            .ok_or_else(|| AppError::NotFound("No worktree found for this feature".into()))?;

    if is_default_worktree_path(&project_path, &wt_path) {
        return Ok(default_worktree_blocked());
    }

    // A live Neovim has this worktree as its cwd (and may hold swap files in
    // it), so `git worktree remove` would fail or leave residue. `/api/terminal/
    // kill` deliberately spares the editor PTY, which makes this the last point
    // where it can still be torn down. Errors are ignored: not running is the
    // common case, and a stubborn process should not block the removal.
    if let Err(error) = state.neovim_manager.stop(params.feature_id).await {
        debug!(%error, feature_id = params.feature_id, "no neovim to stop before worktree removal");
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
    ensure_feature_belongs_to_project(&state.read_pool, body.feature_id, body.project_id).await?;
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

pub async fn remove_orphan_worktree(
    state: &AppState,
    body: RemoveOrphanWorktreeBody,
) -> Result<SuccessResponse, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, body.project_id).await?;
    if is_default_worktree_path(&project_path, &body.worktree_path) {
        return Ok(default_worktree_blocked());
    }
    if let Err(error) = commands::require_registered_worktree(
        Path::new(&project_path),
        Path::new(&body.worktree_path),
    )
    .await
    {
        return Ok(error_response(error));
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

pub(super) fn is_default_worktree_path(project_path: &str, worktree_path: &str) -> bool {
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
