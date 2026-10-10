use axum::extract::{Json, Path, State};
use axum::routing::{get, post};
use axum::Router;

use super::models::{
    ArchivePreview, ArchiveProjectSessionsResponse, ArchiveRequest, ArchiveResponse,
};
use super::service;
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::error::AppError;

#[utoipa::path(get, path = "/api/features/{id}/archive-preview",
    operation_id = "getFeatureArchivePreview",
    params(("id" = i64, Path,)),
    responses((status = 200, body = ArchivePreview)))]
pub async fn archive_preview_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArchivePreview>, AppError> {
    Ok(Json(service::archive_preview(&state.read_pool, id).await?))
}

#[utoipa::path(post, path = "/api/features/{id}/archive",
    operation_id = "archiveFeature",
    params(("id" = i64, Path,)),
    request_body = ArchiveRequest,
    responses((status = 200, body = ArchiveResponse)))]
pub async fn archive_feature_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<ArchiveRequest>,
) -> Result<Json<ArchiveResponse>, AppError> {
    let response = service::archive(&state.write_pool, id, body).await?;
    for archived_id in &response.archived_ids {
        state
            .feature_events_tx
            .emit(*archived_id, None, FeatureEventAction::Updated);
    }
    Ok(Json(response))
}

#[utoipa::path(post, path = "/api/projects/{id}/archive-sessions",
    operation_id = "archiveProjectSessions",
    params(("id" = i64, Path,)),
    responses((status = 200, body = ArchiveProjectSessionsResponse)))]
pub async fn archive_project_sessions_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArchiveProjectSessionsResponse>, AppError> {
    let response = service::archive_project_sessions(&state.write_pool, id).await?;
    for archived_id in &response.archived_ids {
        state
            .feature_events_tx
            .emit(*archived_id, None, FeatureEventAction::Updated);
    }
    Ok(Json(response))
}

pub fn archive_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features/{id}/archive-preview",
            get(archive_preview_handler),
        )
        .route("/api/features/{id}/archive", post(archive_feature_handler))
        // Project-scoped bulk archive lives here (not in the projects router)
        // so it shares the archive service module with the single-feature path.
        .route(
            "/api/projects/{id}/archive-sessions",
            post(archive_project_sessions_handler),
        )
}
