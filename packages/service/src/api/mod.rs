#![allow(clippy::result_large_err)]

pub mod middleware;
pub mod openapi;

use crate::app_state::AppState;
use crate::domain::agents::claude_code::routes::claude_code_router;
use crate::domain::agents::discovery::routes::discovery_router;
use crate::domain::agents::runtime::AgentCatalogResponse;
use crate::domain::custom_actions::routes::custom_actions_router;
use crate::domain::diff_comments::routes::diff_comments_router;
use crate::domain::editor::mutation_routes::editor_mutation_router;
use crate::domain::editor::routes::editor_router;
use crate::domain::feature_layouts::routes::feature_layouts_router;
use crate::domain::features::routes::features_router;
use crate::domain::git::routes::git_router;
use crate::domain::projects::routes::projects_router;
use crate::domain::sessions::routes::sessions_router;
use crate::domain::terminal::routes::terminal_router;
use crate::domain::workspace::routes::workspace_router;
use crate::domain::ws_session::handler::ws_handler;
use axum::extract::{Query, State};
use axum::routing::get;
use axum::Json;
use axum::Router;
use serde::Deserialize;
use std::path::PathBuf;

#[utoipa::path(
    get,
    path = "/api/agent-catalog",
    params(("cwd" = Option<String>, Query, description = "Workspace path used to discover project-local provider modes")),
    responses((status = 200, body = AgentCatalogResponse))
)]
pub async fn get_agent_catalog(
    State(state): State<AppState>,
    Query(query): Query<AgentCatalogQuery>,
) -> Json<AgentCatalogResponse> {
    let catalog = match query.cwd.as_deref() {
        Some(cwd) => {
            crate::domain::agents::providers::provider_catalog_live_for_cwd(
                &state.read_pool,
                Some(cwd),
            )
            .await
        }
        None => crate::domain::agents::providers::provider_catalog_live(&state.read_pool).await,
    };
    Json(catalog)
}

#[derive(Debug, Deserialize)]
pub struct AgentCatalogQuery {
    cwd: Option<PathBuf>,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(openapi::routes())
        .merge(git_router())
        .merge(workspace_router())
        .merge(projects_router())
        .merge(features_router())
        .merge(feature_layouts_router())
        .merge(diff_comments_router())
        .merge(sessions_router())
        .merge(terminal_router())
        .merge(editor_router())
        .merge(editor_mutation_router())
        .merge(claude_code_router())
        .merge(custom_actions_router())
        .merge(discovery_router())
        .route("/ws", get(ws_handler))
        .route("/api/agent-catalog", get(get_agent_catalog))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::auth_middleware,
        ))
        // Compression sits OUTSIDE auth so 401 bodies also compress.
        // Tower's CompressionLayer automatically skips `Upgrade` (WebSocket) requests.
        .layer(
            tower_http::compression::CompressionLayer::new()
                .gzip(true)
                .br(true),
        )
        .with_state(state)
}
