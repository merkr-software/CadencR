//! `POST /api/features/{id}/branches/link` and `.../unlink` — the header's
//! manual corrections to the branches discovered for a conversation.

use std::path::Path as FsPath;

use axum::extract::{Json, Path, State};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use utoipa::ToSchema;

use super::{refresh_after_change, repository, BranchRef};
use crate::app_state::AppState;
use crate::domain::git::models::SuccessResponse;
use crate::domain::git::service::{
    branch_identity, recorded_feature_branch, resolve_feature_git_path,
};
use crate::domain::git::workflow_service::branch_exists;
use crate::error::AppError;

#[derive(Debug, Deserialize, ToSchema)]
pub struct FeatureBranchBody {
    pub branch: String,
}

#[utoipa::path(
    post,
    path = "/api/features/{id}/branches/link",
    params(("id" = i64, Path,)),
    request_body = FeatureBranchBody,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn link_feature_branch_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<FeatureBranchBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    let branch = parse_branch(&body.branch)?;
    let git_path = resolve_feature_git_path(&state, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {id} has no git path")))?;
    if !branch_exists(FsPath::new(&git_path), &branch).await? {
        return Err(AppError::BadRequest(format!(
            "branch '{branch}' does not resolve locally or on origin"
        )));
    }
    let key = BranchRef {
        feature_id: id,
        branch: &branch,
    };
    repository::link_manual(&state.write_pool, key).await?;
    refresh_after_change(&state, id).await;
    Ok(Json(SuccessResponse::ok()))
}

#[utoipa::path(
    post,
    path = "/api/features/{id}/branches/unlink",
    params(("id" = i64, Path,)),
    request_body = FeatureBranchBody,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn unlink_feature_branch_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<FeatureBranchBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    let branch = parse_branch(&body.branch)?;
    if recorded_feature_branch(&state.read_pool, id)
        .await?
        .as_deref()
        == Some(branch.as_str())
    {
        return Err(AppError::BadRequest(
            "This is the branch the conversation was created on; it cannot be unlinked.".into(),
        ));
    }
    let key = BranchRef {
        feature_id: id,
        branch: &branch,
    };
    repository::unlink(&state.write_pool, key).await?;
    refresh_after_change(&state, id).await;
    Ok(Json(SuccessResponse::ok()))
}

fn parse_branch(raw: &str) -> Result<String, AppError> {
    branch_identity(raw).ok_or_else(|| AppError::BadRequest("branch must name a branch".into()))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features/{id}/branches/link",
            post(link_feature_branch_handler),
        )
        .route(
            "/api/features/{id}/branches/unlink",
            post(unlink_feature_branch_handler),
        )
}
