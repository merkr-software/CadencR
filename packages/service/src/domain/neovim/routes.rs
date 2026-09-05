use std::num::ParseIntError;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{routing::post, Json, Router};

use crate::app_state::AppState;
use crate::error::AppError;

use super::protocol::{NeovimDetectResponse, NeovimStartResponse, OpenFileRequest};

#[utoipa::path(
    post,
    path = "/api/neovim/start",
    request_body = i64,
    responses(
        (status = 200, body = NeovimStartResponse),
        (status = 500, description = "Spawn failed")
    )
)]
pub async fn start_route(
    State(state): State<AppState>,
    Json(feature_id): Json<i64>,
) -> Result<Json<NeovimStartResponse>, AppError> {
    let result = state.neovim_manager.start(feature_id).await?;
    Ok(Json(result))
}

#[utoipa::path(
    post,
    path = "/api/neovim/stop",
    request_body = i64,
    responses(
        (status = 200, description = "Stopped"),
        (status = 404, description = "Not running")
    )
)]
pub async fn stop_route(
    State(state): State<AppState>,
    Json(feature_id): Json<i64>,
) -> Result<(), AppError> {
    state.neovim_manager.stop(feature_id).await
}

#[utoipa::path(
    get,
    path = "/api/neovim/detect",
    responses((status = 200, body = NeovimDetectResponse))
)]
pub async fn detect_route(State(_state): State<AppState>) -> Json<NeovimDetectResponse> {
    let available = crate::domain::neovim::service::nvim_available().await;
    Json(NeovimDetectResponse { available })
}

/// POST /api/features/{feature_id}/neovim/open
///
/// Opens a file in the feature's Neovim session and moves the cursor to the
/// requested position. `line` and `col` are 1-indexed.
#[utoipa::path(
    post,
    path = "/api/features/{feature_id}/neovim/open",
    params(("feature_id" = String, Path, description = "Feature ID")),
    request_body = OpenFileRequest,
    responses((status = 204, description = "File opened successfully")),
)]
pub async fn open_file_route(
    State(app_state): State<AppState>,
    Path(feature_id): Path<String>,
    axum::Json(request): axum::Json<OpenFileRequest>,
) -> Result<StatusCode, AppError> {
    let feature_id: i64 = feature_id
        .parse()
        .map_err(|e: ParseIntError| AppError::BadRequest(format!("Invalid feature_id: {e}")))?;
    app_state
        .neovim_manager
        .open_file(feature_id, &request.path, request.line, request.col)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/neovim/start", axum::routing::post(start_route))
        .route("/api/neovim/stop", axum::routing::post(stop_route))
        .route("/api/neovim/detect", axum::routing::get(detect_route))
        .route(
            "/api/features/{feature_id}/neovim/open",
            post(open_file_route),
        )
}
