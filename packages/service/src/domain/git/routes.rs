use axum::extract::{Json, Path, Query, State};
use axum::routing::{delete, get, patch, post};
use axum::Router;

use crate::app_state::AppState;
use crate::domain::git::git_status::GitStatusSnapshot;
use crate::domain::git::models::*;
use crate::domain::git::porcelain::UncommittedFile;
use crate::domain::git::service;
use crate::domain::git::workflow_service;
use crate::error::AppError;

mod mutations;
mod paths;
pub use mutations::*;
pub use paths::*;

#[utoipa::path(get, path = "/api/git/branch", params(("project_id" = i64, Query,)), responses((status = 200, body = BranchResponse)))]
pub async fn get_branch_handler(
    State(state): State<AppState>,
    Query(params): Query<GetBranchParams>,
) -> Result<Json<BranchResponse>, AppError> {
    Ok(Json(service::get_branch(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/stats", params(("feature_id" = i64, Query,), ("mode" = Option<String>, Query,), ("target_branch" = Option<String>, Query,)), responses((status = 200, body = GitStats)))]
pub async fn get_stats_handler(
    State(state): State<AppState>,
    Query(params): Query<GetStatsParams>,
) -> Result<Json<GitStats>, AppError> {
    Ok(Json(service::get_stats(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/diff", params(("feature_id" = i64, Query,), ("mode" = String, Query,), ("commit_sha" = Option<String>, Query,), ("target_branch" = Option<String>, Query,)), responses((status = 200, body = DiffResponse)))]
pub async fn get_diff_handler(
    State(state): State<AppState>,
    Query(params): Query<GetDiffParams>,
) -> Result<Json<DiffResponse>, AppError> {
    Ok(Json(service::get_diff(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/changed-files", params(("feature_id" = i64, Query,), ("mode" = String, Query,), ("commit_sha" = Option<String>, Query,), ("target_branch" = Option<String>, Query,)), responses((status = 200, body = Vec<ChangedFile>)))]
pub async fn get_changed_files_handler(
    State(state): State<AppState>,
    Query(params): Query<GetChangedFilesParams>,
) -> Result<Json<Vec<ChangedFile>>, AppError> {
    Ok(Json(service::get_changed_files(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/file-diff", params(("feature_id" = i64, Query,), ("file_path" = String, Query,), ("old_file_path" = Option<String>, Query,), ("mode" = String, Query,), ("commit_sha" = Option<String>, Query,), ("target_branch" = Option<String>, Query,)), responses((status = 200, body = DiffResponse)))]
pub async fn get_file_diff_handler(
    State(state): State<AppState>,
    Query(params): Query<GetFileDiffParams>,
) -> Result<Json<DiffResponse>, AppError> {
    Ok(Json(service::get_file_diff(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/file-content", params(("feature_id" = i64, Query,), ("file_path" = String, Query,), ("mode" = String, Query,), ("commit_sha" = Option<String>, Query,), ("target_branch" = Option<String>, Query,)), responses((status = 200, body = FileContent)))]
pub async fn get_file_content_handler(
    State(state): State<AppState>,
    Query(params): Query<GetFileContentParams>,
) -> Result<Json<FileContent>, AppError> {
    Ok(Json(service::get_file_content(&state, params).await?))
}

pub async fn get_diff_image_handler(
    State(state): State<AppState>,
    Query(params): Query<GetDiffImageParams>,
) -> Result<axum::response::Response, AppError> {
    let image = service::get_diff_image(&state, params).await?;
    crate::shared::image_file::image_response(image.bytes, image.mime)
}

#[utoipa::path(post, path = "/api/git/file-content-batch", request_body = GetFileContentBatchBody, responses((status = 200, body = Vec<FileContentBatchItem>)))]
pub async fn get_file_content_batch_handler(
    State(state): State<AppState>,
    Json(body): Json<GetFileContentBatchBody>,
) -> Result<Json<Vec<FileContentBatchItem>>, AppError> {
    Ok(Json(service::get_file_content_batch(&state, body).await?))
}

#[utoipa::path(get, path = "/api/git/commit-log", params(("feature_id" = i64, Query,), ("limit" = Option<i64>, Query,)), responses((status = 200, body = CommitLogResponse)))]
pub async fn get_commit_log_handler(
    State(state): State<AppState>,
    Query(params): Query<GetCommitLogParams>,
) -> Result<Json<CommitLogResponse>, AppError> {
    Ok(Json(service::get_commit_log(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/commit-graph", params(("feature_id" = i64, Query,), ("branch" = Option<String>, Query,), ("branch_is_local" = Option<bool>, Query,), ("skip" = Option<i64>, Query,), ("limit" = Option<i64>, Query,)), responses((status = 200, body = CommitGraphResponse)))]
pub async fn get_commit_graph_handler(
    State(state): State<AppState>,
    Query(params): Query<GetCommitGraphParams>,
) -> Result<Json<CommitGraphResponse>, AppError> {
    Ok(Json(service::get_commit_graph(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/commit-url", params(("feature_id" = i64, Query,), ("sha" = String, Query,)), responses((status = 200, body = CommitUrlResponse)))]
pub async fn get_commit_url_handler(
    State(state): State<AppState>,
    Query(params): Query<GetCommitUrlParams>,
) -> Result<Json<CommitUrlResponse>, AppError> {
    Ok(Json(service::get_commit_url(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/stashes", params(("feature_id" = i64, Query,)), responses((status = 200, body = Vec<StashEntry>)))]
pub async fn list_stashes_handler(
    State(state): State<AppState>,
    Query(params): Query<ListStashesParams>,
) -> Result<Json<Vec<StashEntry>>, AppError> {
    Ok(Json(service::list_stashes(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/files", params(("feature_id" = i64, Query,)), responses((status = 200, body = Vec<String>)))]
pub async fn list_files_handler(
    State(state): State<AppState>,
    Query(params): Query<ListFilesParams>,
) -> Result<Json<Vec<String>>, AppError> {
    Ok(Json(service::list_files(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/worktree/info", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = Option<WorktreeInfo>)))]
pub async fn get_worktree_info_handler(
    State(state): State<AppState>,
    Query(params): Query<WorktreeInfoParams>,
) -> Result<Json<Option<WorktreeInfo>>, AppError> {
    Ok(Json(service::get_worktree_info(&state, params).await?))
}

#[utoipa::path(post, path = "/api/git/worktree", request_body = CreateWorktreeBody, responses((status = 200, body = CreateWorktreeResponse)))]
pub async fn create_worktree_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateWorktreeBody>,
) -> Result<Json<CreateWorktreeResponse>, AppError> {
    Ok(Json(service::create_worktree(&state, body).await?))
}

#[utoipa::path(delete, path = "/api/git/worktree", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = SuccessResponse)))]
pub async fn remove_worktree_handler(
    State(state): State<AppState>,
    Query(params): Query<RemoveWorktreeParams>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(service::remove_worktree(&state, params).await?))
}

#[utoipa::path(delete, path = "/api/git/worktree/safe", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,), ("force" = Option<bool>, Query,)), responses((status = 200, body = SuccessResponse)))]
pub async fn delete_worktree_handler(
    State(state): State<AppState>,
    Query(params): Query<DeleteWorktreeParams>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(service::delete_worktree(&state, params).await?))
}

#[utoipa::path(post, path = "/api/git/worktree/retry", request_body = RetryWorktreeBody, responses((status = 200, body = SuccessResponse)))]
pub async fn retry_worktree_setup_handler(
    State(state): State<AppState>,
    Json(body): Json<RetryWorktreeBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(service::retry_worktree_setup(&state, body).await?))
}

#[utoipa::path(get, path = "/api/git/worktrees", params(("project_id" = i64, Query,)), responses((status = 200, body = Vec<ProjectWorktreeInfo>)))]
pub async fn list_project_worktrees_handler(
    State(state): State<AppState>,
    Query(params): Query<ListProjectWorktreesParams>,
) -> Result<Json<Vec<ProjectWorktreeInfo>>, AppError> {
    Ok(Json(service::list_project_worktrees(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/feature-worktrees", params(("project_id" = i64, Query,)), responses((status = 200, body = Vec<FeatureWorktreeInfo>)))]
pub async fn list_feature_worktrees_handler(
    State(state): State<AppState>,
    Query(params): Query<ListFeatureWorktreesParams>,
) -> Result<Json<Vec<FeatureWorktreeInfo>>, AppError> {
    Ok(Json(service::list_feature_worktrees(&state, params).await?))
}

#[utoipa::path(delete, path = "/api/git/worktree/orphan", request_body = RemoveOrphanWorktreeBody, responses((status = 200, body = SuccessResponse)))]
pub async fn remove_orphan_worktree_handler(
    State(state): State<AppState>,
    Json(body): Json<RemoveOrphanWorktreeBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(service::remove_orphan_worktree(&state, body).await?))
}

#[utoipa::path(get, path = "/api/git/original-branch", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = OriginalBranchResponse)))]
pub async fn get_original_branch_handler(
    State(state): State<AppState>,
    Query(params): Query<GetOriginalBranchParams>,
) -> Result<Json<OriginalBranchResponse>, AppError> {
    Ok(Json(service::get_original_branch(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/merge-conflicts", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = MergeConflictResult)))]
pub async fn check_merge_conflicts_handler(
    State(state): State<AppState>,
    Query(params): Query<CheckMergeConflictsParams>,
) -> Result<Json<MergeConflictResult>, AppError> {
    Ok(Json(service::check_merge_conflicts(&state, params).await?))
}

#[utoipa::path(post, path = "/api/git/merge", request_body = workflow_service::MergeFeatureBranchBody, responses((status = 200, body = MergeResult)))]
pub async fn merge_feature_branch_handler(
    State(state): State<AppState>,
    Json(body): Json<workflow_service::MergeFeatureBranchBody>,
) -> Result<Json<MergeResult>, AppError> {
    Ok(Json(
        workflow_service::merge_feature_branch(&state, body).await?,
    ))
}

#[utoipa::path(delete, path = "/api/git/branch", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,), ("force" = Option<bool>, Query,)), responses((status = 200, body = SuccessResponse)))]
pub async fn delete_feature_branch_handler(
    State(state): State<AppState>,
    Query(params): Query<DeleteFeatureBranchParams>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(service::delete_feature_branch(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/branch/delete-check", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = BranchDeleteCheckResponse)))]
pub async fn check_branch_delete_handler(
    State(state): State<AppState>,
    Query(params): Query<BranchDeleteCheckParams>,
) -> Result<Json<BranchDeleteCheckResponse>, AppError> {
    Ok(Json(service::check_branch_delete(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/has-uncommitted-changes", params(("project_id" = i64, Query,), ("feature_id" = i64, Query,)), responses((status = 200, body = HasUncommittedChangesResponse)))]
pub async fn has_uncommitted_changes_handler(
    State(state): State<AppState>,
    Query(params): Query<HasUncommittedChangesParams>,
) -> Result<Json<HasUncommittedChangesResponse>, AppError> {
    Ok(Json(
        service::has_uncommitted_changes(&state, params).await?,
    ))
}

#[utoipa::path(get, path = "/api/git/blame", params(("project_id" = i64, Query,), ("feature_id" = Option<i64>, Query,), ("file_path" = String, Query,)), responses((status = 200, body = BlameResponse)))]
pub async fn get_blame_handler(
    State(state): State<AppState>,
    Query(params): Query<GetBlameParams>,
) -> Result<Json<BlameResponse>, AppError> {
    Ok(Json(service::get_blame(&state, params).await?))
}

// ---------------------------------------------------------------------------
// Git workflow overhaul: branches / status / compare-url / target-branch
// ---------------------------------------------------------------------------

#[utoipa::path(
    get,
    path = "/api/git/branches",
    params(("project_id" = i64, Query,)),
    responses((status = 200, body = Vec<BranchInfo>))
)]
pub async fn list_branches_handler(
    State(state): State<AppState>,
    Query(params): Query<ListBranchesParams>,
) -> Result<Json<Vec<BranchInfo>>, AppError> {
    Ok(Json(workflow_service::list_branches(&state, params).await?))
}

#[utoipa::path(
    get,
    path = "/api/git/status",
    params(("feature_id" = i64, Query,)),
    responses((status = 200, body = GitStatusSnapshot))
)]
pub async fn get_git_status_handler(
    State(state): State<AppState>,
    Query(params): Query<GetGitStatusParams>,
) -> Result<Json<GitStatusSnapshot>, AppError> {
    Ok(Json(
        workflow_service::get_git_status(&state, params).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/git/compare-url",
    params(("feature_id" = i64, Query,)),
    responses((status = 200, body = CompareUrlResponse))
)]
pub async fn get_compare_url_handler(
    State(state): State<AppState>,
    Query(params): Query<GetCompareUrlParams>,
) -> Result<Json<CompareUrlResponse>, AppError> {
    Ok(Json(
        workflow_service::get_compare_url(&state, params).await?,
    ))
}

#[utoipa::path(
    get,
    path = "/api/git/uncommitted-files",
    params(("feature_id" = i64, Query,)),
    responses((status = 200, body = Vec<UncommittedFile>))
)]
pub async fn get_uncommitted_files_handler(
    State(state): State<AppState>,
    Query(params): Query<GetUncommittedFilesParams>,
) -> Result<Json<Vec<UncommittedFile>>, AppError> {
    Ok(Json(
        workflow_service::get_uncommitted_files(&state, params).await?,
    ))
}

// Checkout handlers live alongside the service implementation in
// `workflow_service::checkout` so this catalog stays under the 400-line cap.
pub use workflow_service::checkout::{checkout_branch_handler, validate_checkout_handler};

#[utoipa::path(
    patch,
    path = "/api/features/{id}/target-branch",
    params(("id" = i64, Path,)),
    request_body = UpdateTargetBranchBody,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn update_target_branch_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateTargetBranchBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(
        workflow_service::update_target_branch(&state, id, body).await?,
    ))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

#[rustfmt::skip]
pub fn git_router() -> Router<AppState> {
    Router::new()
        .route("/api/git/branch", get(get_branch_handler).delete(delete_feature_branch_handler))
        .route("/api/git/branch/delete-check", get(check_branch_delete_handler))
        .route("/api/git/stats", get(get_stats_handler))
        .route("/api/git/diff", get(get_diff_handler))
        .route("/api/git/file-diff", get(get_file_diff_handler))
        .route("/api/git/changed-files", get(get_changed_files_handler))
        .route("/api/git/file-content", get(get_file_content_handler))
        .route("/api/git/diff-image", get(get_diff_image_handler))
        .route("/api/git/file-content-batch", post(get_file_content_batch_handler))
        .route("/api/git/commit-log", get(get_commit_log_handler))
        .route("/api/git/commit-graph", get(get_commit_graph_handler))
        .route("/api/git/commit-url", get(get_commit_url_handler))
        .route("/api/git/file-blob-shas", get(get_file_blob_shas_handler))
        .route("/api/git/path-prefix", get(get_git_path_prefix_handler))
        .route("/api/git/stashes", get(list_stashes_handler))
        .route("/api/git/stashes/push", post(push_stash_handler))
        .route("/api/git/stashes/apply", post(apply_stash_handler))
        .route("/api/git/stashes/pop", post(pop_stash_handler))
        .route("/api/git/stashes/drop", post(drop_stash_handler))
        .route("/api/git/index/stage", post(stage_file_handler))
        .route("/api/git/index/reset", post(reset_file_handler))
        .route("/api/git/files", get(list_files_handler))
        .route("/api/git/worktree/info", get(get_worktree_info_handler))
        .route("/api/git/worktree", post(create_worktree_handler).delete(remove_worktree_handler))
        .route("/api/git/worktree/safe", delete(delete_worktree_handler))
        .route("/api/git/worktree/retry", post(retry_worktree_setup_handler))
        .route("/api/git/worktrees", get(list_project_worktrees_handler))
        .route("/api/git/feature-worktrees", get(list_feature_worktrees_handler))
        .route("/api/git/worktree/orphan", delete(remove_orphan_worktree_handler))
        .route("/api/git/original-branch", get(get_original_branch_handler))
        .route("/api/git/merge-conflicts", get(check_merge_conflicts_handler))
        .route("/api/git/merge", post(merge_feature_branch_handler))
        .route("/api/git/has-uncommitted-changes", get(has_uncommitted_changes_handler))
        .route("/api/git/blame", get(get_blame_handler))
        // Git workflow overhaul
        .route("/api/git/branches", get(list_branches_handler))
        .route("/api/git/status", get(get_git_status_handler))
        .route("/api/git/compare-url", get(get_compare_url_handler))
        .route(
            "/api/features/{id}/target-branch",
            patch(update_target_branch_handler),
        )
        .route("/api/git/checkout", post(checkout_branch_handler))
        .route(
            "/api/git/checkout/validate",
            post(validate_checkout_handler),
        )
        .route("/api/git/commit", post(commit_handler))
        .route("/api/git/push", post(push_handler))
        .route("/api/git/push-input", post(push_input_handler))
        .route("/api/git/update-branch", post(update_branch_handler))
        .route("/api/git/update-branch/continue", post(continue_update_branch_handler))
        .route("/api/git/update-branch/abort", post(abort_update_branch_handler))
        .route(
            "/api/git/uncommitted-files",
            get(get_uncommitted_files_handler),
        )
        .merge(super::forge::routes::forge_router())
        .merge(super::linked_branches::routes::router())
}
