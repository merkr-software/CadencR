//! The cleanup of an archived conversation: read it, resume it.

use axum::extract::{Json, Path, State};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{journal, runner, CleanupReport};
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchiveCleanupStatus {
    pub feature_id: i64,
    pub project_id: i64,
    pub title: String,
    /// A run is executing its steps right now.
    pub running: bool,
    /// Every requested step is done or had nothing to do.
    pub settled: bool,
    pub cleanup: CleanupReport,
}

/// Resume an archive cleanup, forcing the steps the user confirmed.
#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct RetryArchiveCleanupRequest {
    /// Discard the worktree's uncommitted changes.
    #[serde(default)]
    pub force_remove_worktree: bool,
    /// Delete the branch even though it is not merged.
    #[serde(default)]
    pub force_remove_branch: bool,
}

#[utoipa::path(get, path = "/api/features/{id}/archive-cleanup",
    operation_id = "getArchiveCleanup",
    params(("id" = i64, Path,)),
    responses((status = 200, body = ArchiveCleanupStatus)))]
pub async fn get_archive_cleanup_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArchiveCleanupStatus>, AppError> {
    status_of(&state, id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound("This session has no archive cleanup".into()))
}

#[utoipa::path(post, path = "/api/features/{id}/archive-cleanup/retry",
    operation_id = "retryArchiveCleanup",
    params(("id" = i64, Path,)),
    request_body = RetryArchiveCleanupRequest,
    responses((status = 200, body = ArchiveCleanupStatus)))]
pub async fn retry_archive_cleanup_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<RetryArchiveCleanupRequest>,
) -> Result<Json<ArchiveCleanupStatus>, AppError> {
    let force = runner::ResumeForce {
        worktree: body.force_remove_worktree,
        branch: body.force_remove_branch,
    };
    runner::resume(&state, id, force).await?;
    status_of(&state, id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound("This session has no archive cleanup".into()))
}

/// Archived conversations whose cleanup is not settled: in progress, waiting,
/// interrupted, blocked or failed.
#[utoipa::path(get, path = "/api/archive-cleanups",
    operation_id = "listArchiveCleanups",
    responses((status = 200, body = Vec<ArchiveCleanupStatus>)))]
pub async fn list_archive_cleanups_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<ArchiveCleanupStatus>>, AppError> {
    let mut statuses = Vec::new();
    for feature_id in journal::unsettled_feature_ids(&state.read_pool).await? {
        if let Some(status) = status_of(&state, feature_id).await? {
            statuses.push(status);
        }
    }
    Ok(Json(statuses))
}

async fn status_of(
    state: &AppState,
    feature_id: i64,
) -> Result<Option<ArchiveCleanupStatus>, AppError> {
    let feature: Option<(i64, String)> =
        sqlx::query_as("SELECT project_id, title FROM features WHERE id = ?")
            .bind(feature_id)
            .fetch_optional(&state.read_pool)
            .await?;
    let Some((project_id, title)) = feature else {
        return Ok(None);
    };
    let cleanup = runner::current_report(state, feature_id).await?;
    if cleanup == CleanupReport::default() {
        return Ok(None);
    }
    Ok(Some(ArchiveCleanupStatus {
        feature_id,
        project_id,
        title,
        running: runner::is_running(state, feature_id),
        settled: cleanup.is_settled(),
        cleanup,
    }))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features/{id}/archive-cleanup",
            get(get_archive_cleanup_handler),
        )
        .route(
            "/api/features/{id}/archive-cleanup/retry",
            post(retry_archive_cleanup_handler),
        )
        .route("/api/archive-cleanups", get(list_archive_cleanups_handler))
}
