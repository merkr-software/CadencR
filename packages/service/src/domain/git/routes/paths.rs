//! Endpoints about how the Git tab's repository-relative paths map onto the
//! feature's directory.

use axum::extract::{Json, Query, State};

use crate::app_state::AppState;
use crate::domain::git::models::{
    FileBlobSha, GetFileBlobShasParams, GetGitPathPrefixParams, GitPathPrefixResponse,
};
use crate::domain::git::service;
use crate::error::AppError;

#[utoipa::path(get, path = "/api/git/file-blob-shas", params(("feature_id" = i64, Query,)), responses((status = 200, body = Vec<FileBlobSha>)))]
pub async fn get_file_blob_shas_handler(
    State(state): State<AppState>,
    Query(params): Query<GetFileBlobShasParams>,
) -> Result<Json<Vec<FileBlobSha>>, AppError> {
    Ok(Json(service::get_file_blob_shas(&state, params).await?))
}

#[utoipa::path(get, path = "/api/git/path-prefix", params(("feature_id" = i64, Query,)), responses((status = 200, body = GitPathPrefixResponse)))]
pub async fn get_git_path_prefix_handler(
    State(state): State<AppState>,
    Query(params): Query<GetGitPathPrefixParams>,
) -> Result<Json<GitPathPrefixResponse>, AppError> {
    Ok(Json(service::get_git_path_prefix(&state, params).await?))
}
