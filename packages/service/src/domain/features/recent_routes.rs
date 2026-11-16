use axum::extract::{Json, Query, State};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use super::models::Feature;
use super::service;
use crate::app_state::AppState;
use crate::error::AppError;

const DEFAULT_RECENT_LIMIT: i64 = 5;
const MAX_RECENT_LIMIT: i64 = 50;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListRecentFeaturesParams {
    /// How many conversations to return (1–50, default 5).
    pub limit: Option<i64>,
}

/// The active conversations touched most recently, across every project.
#[utoipa::path(get, path = "/api/features/recent",
    params(ListRecentFeaturesParams),
    responses((status = 200, body = Vec<Feature>)))]
pub async fn list_recent_features_handler(
    State(state): State<AppState>,
    Query(params): Query<ListRecentFeaturesParams>,
) -> Result<Json<Vec<Feature>>, AppError> {
    let limit = params
        .limit
        .unwrap_or(DEFAULT_RECENT_LIMIT)
        .clamp(1, MAX_RECENT_LIMIT);
    Ok(Json(service::list_recent(&state.read_pool, limit).await?))
}

/// Every active conversation across all projects, most recently touched first.
#[utoipa::path(get, path = "/api/features/active",
    responses((status = 200, body = Vec<Feature>)))]
pub async fn list_active_features_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<Feature>>, AppError> {
    Ok(Json(service::list_active(&state.read_pool).await?))
}

pub fn recent_routes() -> Router<AppState> {
    Router::new()
        .route("/api/features/recent", get(list_recent_features_handler))
        .route("/api/features/active", get(list_active_features_handler))
}
