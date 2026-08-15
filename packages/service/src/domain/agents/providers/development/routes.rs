use axum::extract::{Json, State};
use axum::routing::post;
use axum::Router;

use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::error::AppError;

use super::models::{CreateProviderWorkspaceRequest, ProviderWorkspace};
use super::workspace;

#[utoipa::path(
    post,
    path = "/api/agents/provider-workspaces",
    request_body = CreateProviderWorkspaceRequest,
    responses(
        (status = 200, body = ProviderWorkspace),
        (status = 400, description = "Provider identity or display name is invalid"),
        (status = 409, description = "Provider id or workspace already exists")
    )
)]
pub async fn create_provider_workspace_handler(
    State(state): State<AppState>,
    Json(request): Json<CreateProviderWorkspaceRequest>,
) -> Result<Json<ProviderWorkspace>, AppError> {
    let created = workspace::create(
        &state.write_pool,
        &request.provider_id,
        &request.display_name,
    )
    .await?;
    state.feature_events_tx.emit(
        created.feature_id,
        Some(created.project_id),
        FeatureEventAction::Created,
    );
    Ok(Json(created))
}

/// Developer workspace creation changes host-local files and is loopback-only.
pub fn provider_development_router() -> Router<AppState> {
    Router::new().route(
        "/api/agents/provider-workspaces",
        post(create_provider_workspace_handler),
    )
}
