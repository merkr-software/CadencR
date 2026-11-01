//! Skill and MCP server endpoints. Every route runs the user's agent CLIs on
//! the host (listing included: `mcp list` health-checks servers), so the whole
//! surface is loopback-only.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use super::mcp_registry::PAGE_SIZE;
use super::mcp_service;
use super::service::{detached, service};
use super::skills_service::{self, SkillAction, SkillFilter};
use super::types::{
    ExtensionClisResponse, McpInstallRequest, McpInventoryResponse, McpRegistryPage,
    McpRegistryServer, McpServerRequest, SkillCatalogResponse, SkillRequest,
};
use crate::app_state::AppState;
use crate::error::AppError;

const MAX_SKILLS_PAGE: usize = 1000;

#[utoipa::path(
    get,
    path = "/api/agent-extensions/clis",
    responses((status = 200, body = ExtensionClisResponse))
)]
pub async fn list_extension_clis(
    State(state): State<AppState>,
) -> Result<Json<ExtensionClisResponse>, AppError> {
    let hosts = service().hosts(&state.read_pool).await;
    Ok(Json(ExtensionClisResponse {
        clis: hosts.iter().map(|host| host.summary()).collect(),
    }))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct McpRegistryQuery {
    /// Substring of the registry name.
    #[serde(default)]
    pub q: String,
    pub cursor: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/agent-extensions/mcp/registry",
    params(McpRegistryQuery),
    responses((status = 200, body = McpRegistryPage), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn search_mcp_registry(
    Query(query): Query<McpRegistryQuery>,
) -> Result<Json<McpRegistryPage>, AppError> {
    let page = service()
        .registry
        .search(&query.q, query.cursor.as_deref(), PAGE_SIZE)
        .await?;
    Ok(Json(page))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct McpRegistryServerQuery {
    pub name: String,
}

#[utoipa::path(
    get,
    path = "/api/agent-extensions/mcp/registry/server",
    params(McpRegistryServerQuery),
    responses((status = 200, body = McpRegistryServer), (status = 404, description = "NOT_FOUND"))
)]
pub async fn get_mcp_registry_server(
    Query(query): Query<McpRegistryServerQuery>,
) -> Result<Json<McpRegistryServer>, AppError> {
    let entry = service()
        .registry
        .latest(&query.name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("{} is not in the MCP Registry", query.name)))?;
    Ok(Json(entry.server))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct McpInventoryQuery {
    /// List every CLI again instead of the cached inventory.
    #[serde(default)]
    pub refresh: bool,
}

#[utoipa::path(
    get,
    path = "/api/agent-extensions/mcp/installed",
    params(McpInventoryQuery),
    responses((status = 200, body = McpInventoryResponse))
)]
pub async fn list_installed_mcp_servers(
    State(state): State<AppState>,
    Query(query): Query<McpInventoryQuery>,
) -> Result<Json<McpInventoryResponse>, AppError> {
    Ok(Json(
        mcp_service::inventory(&state.read_pool, query.refresh).await,
    ))
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/mcp/install",
    request_body = McpInstallRequest,
    responses(
        (status = 204),
        (status = 400, description = "BAD_REQUEST"),
        (status = 422, description = "EXTENSION_UNSUPPORTED"),
        (status = 502, description = "EXTENSION_CLI_FAILED"),
    )
)]
pub async fn install_mcp_server(
    State(state): State<AppState>,
    Json(request): Json<McpInstallRequest>,
) -> Result<StatusCode, AppError> {
    detached(mcp_service::install(state.read_pool.clone(), request)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/mcp/remove",
    request_body = McpServerRequest,
    responses((status = 204), (status = 422, description = "EXTENSION_UNSUPPORTED"), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn remove_mcp_server(
    State(state): State<AppState>,
    Json(request): Json<McpServerRequest>,
) -> Result<StatusCode, AppError> {
    detached(mcp_service::remove(state.read_pool.clone(), request)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct McpUpdateResponse {
    pub version: String,
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/mcp/update",
    request_body = McpServerRequest,
    responses((status = 200, body = McpUpdateResponse), (status = 422, description = "EXTENSION_UNSUPPORTED"), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn update_mcp_server(
    State(state): State<AppState>,
    Json(request): Json<McpServerRequest>,
) -> Result<Json<McpUpdateResponse>, AppError> {
    let version = detached(mcp_service::update(state.read_pool.clone(), request)).await?;
    Ok(Json(McpUpdateResponse { version }))
}

#[derive(Debug, Clone, Copy, Default, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillCatalogFilter {
    #[default]
    All,
    Installed,
    Updates,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct SkillCatalogQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub filter: SkillCatalogFilter,
    #[serde(default)]
    pub offset: usize,
    pub limit: Option<usize>,
    /// Re-read every CLI's marketplaces from their sources first.
    #[serde(default)]
    pub refresh: bool,
}

#[utoipa::path(
    get,
    path = "/api/agent-extensions/skills",
    params(SkillCatalogQuery),
    responses((status = 200, body = SkillCatalogResponse))
)]
pub async fn list_skills(
    State(state): State<AppState>,
    Query(query): Query<SkillCatalogQuery>,
) -> Result<Json<SkillCatalogResponse>, AppError> {
    let filter = match query.filter {
        SkillCatalogFilter::All => SkillFilter::All,
        SkillCatalogFilter::Installed => SkillFilter::Installed,
        SkillCatalogFilter::Updates => SkillFilter::Updates,
    };
    let limit = query.limit.unwrap_or(60).min(MAX_SKILLS_PAGE);
    Ok(Json(
        skills_service::catalog(
            &state.read_pool,
            &query.q,
            filter,
            query.offset,
            limit,
            query.refresh,
        )
        .await,
    ))
}

async fn skill_action(
    state: AppState,
    request: SkillRequest,
    action: SkillAction,
) -> Result<StatusCode, AppError> {
    detached(skills_service::apply(
        state.read_pool.clone(),
        request,
        action,
    ))
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/skills/install",
    request_body = SkillRequest,
    responses((status = 204), (status = 400, description = "BAD_REQUEST"), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn install_skill(
    State(state): State<AppState>,
    Json(request): Json<SkillRequest>,
) -> Result<StatusCode, AppError> {
    skill_action(state, request, SkillAction::Install).await
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/skills/remove",
    request_body = SkillRequest,
    responses((status = 204), (status = 422, description = "EXTENSION_UNSUPPORTED"), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn remove_skill(
    State(state): State<AppState>,
    Json(request): Json<SkillRequest>,
) -> Result<StatusCode, AppError> {
    skill_action(state, request, SkillAction::Remove).await
}

#[utoipa::path(
    post,
    path = "/api/agent-extensions/skills/update",
    request_body = SkillRequest,
    responses((status = 204), (status = 422, description = "EXTENSION_UNSUPPORTED"), (status = 502, description = "EXTENSION_CLI_FAILED"))
)]
pub async fn update_skill(
    State(state): State<AppState>,
    Json(request): Json<SkillRequest>,
) -> Result<StatusCode, AppError> {
    skill_action(state, request, SkillAction::Update).await
}

pub fn agent_extensions_router() -> Router<AppState> {
    Router::new()
        .route("/api/agent-extensions/clis", get(list_extension_clis))
        .route(
            "/api/agent-extensions/mcp/registry",
            get(search_mcp_registry),
        )
        .route(
            "/api/agent-extensions/mcp/registry/server",
            get(get_mcp_registry_server),
        )
        .route(
            "/api/agent-extensions/mcp/installed",
            get(list_installed_mcp_servers),
        )
        .route(
            "/api/agent-extensions/mcp/install",
            post(install_mcp_server),
        )
        .route("/api/agent-extensions/mcp/remove", post(remove_mcp_server))
        .route("/api/agent-extensions/mcp/update", post(update_mcp_server))
        .route("/api/agent-extensions/skills", get(list_skills))
        .route("/api/agent-extensions/skills/install", post(install_skill))
        .route("/api/agent-extensions/skills/remove", post(remove_skill))
        .route("/api/agent-extensions/skills/update", post(update_skill))
}
