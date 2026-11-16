use axum::extract::{Json, Path, State};
use axum::routing::{get, post};
use axum::Router;

use super::archive::Archiver;
use super::archive_cleanup::runner::archive_with_cleanup;
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

/// Archive a conversation and run the cleanup the request asks for, all
/// orchestrated here: the response carries each step's outcome. The cleanup
/// keeps running if the client goes away, and is journaled for resumption.
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
    let outcome = archive_with_cleanup(&state, id, &body, Archiver::User).await?;
    Ok(Json(ArchiveResponse {
        archived_ids: outcome.archived_ids,
        cleanup: outcome.cleanup,
    }))
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
    state
        .plugin_tab_presence
        .release_features(&response.archived_ids);
    crate::domain::workflow::worktree::cancel_setups(
        &state.worktree_setup_runs,
        &response.archived_ids,
    )
    .await;
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
        .merge(super::archive_cleanup::routes::router())
}
