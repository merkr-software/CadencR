//! Provider update endpoints. Reading status is shared with remote clients;
//! running checks and updates executes programs on the host, so those routes
//! are loopback-only.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

use super::types::{ProviderUpdateRequest, ProviderUpdateStatus, ProviderUpdatesResponse};
use crate::app_state::AppState;
use crate::error::AppError;

#[utoipa::path(
    get,
    path = "/api/agents/provider-updates",
    responses((status = 200, body = ProviderUpdatesResponse))
)]
pub async fn get_provider_updates(
    State(state): State<AppState>,
) -> Result<Json<ProviderUpdatesResponse>, AppError> {
    Ok(Json(state.provider_updates.snapshot()))
}

#[utoipa::path(
    post,
    path = "/api/agents/provider-updates/check",
    responses((status = 200, body = ProviderUpdatesResponse))
)]
pub async fn check_provider_updates(
    State(state): State<AppState>,
) -> Result<Json<ProviderUpdatesResponse>, AppError> {
    Ok(Json(state.provider_updates.check_all().await))
}

#[utoipa::path(
    post,
    path = "/api/agents/provider-updates/{provider_id}/update",
    params(("provider_id" = String, Path, description = "Registered provider id")),
    request_body = ProviderUpdateRequest,
    responses(
        (status = 202, body = ProviderUpdateStatus),
        (status = 400, description = "PROVIDER_UPDATE_TARGET_UNSUPPORTED or PROVIDER_UPDATE_UNKNOWN_VERSION"),
        (status = 404, description = "PROVIDER_NOT_FOUND"),
        (status = 409, description = "PROVIDER_UPDATE_UNSUPPORTED or PROVIDER_UPDATE_IN_PROGRESS"),
    )
)]
pub async fn update_provider(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    Json(request): Json<ProviderUpdateRequest>,
) -> Result<(StatusCode, Json<ProviderUpdateStatus>), AppError> {
    let status = state
        .provider_updates
        .start_update(&provider_id, request.version)?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

pub fn provider_updates_router() -> Router<AppState> {
    Router::new().route("/api/agents/provider-updates", get(get_provider_updates))
}

pub fn provider_update_actions_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/agents/provider-updates/check",
            post(check_provider_updates),
        )
        .route(
            "/api/agents/provider-updates/{provider_id}/update",
            post(update_provider),
        )
}
