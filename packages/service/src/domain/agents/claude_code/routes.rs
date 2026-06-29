//! HTTP routes for Claude Code profiles and custom models.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::domain::agents::runtime::ModelCatalogEntry;
use crate::error::AppError;

use super::{custom_models, profiles};

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ProfileView {
    pub name: String,
    pub env: HashMap<String, String>,
}

impl From<profiles::ClaudeCodeProfile> for ProfileView {
    /// Redacts secret-looking env values. The response path must never expose
    /// token/key/secret/password/auth/credential values; the runtime path
    /// calls `profiles::resolve_active_profile_env` directly for injection.
    fn from(value: profiles::ClaudeCodeProfile) -> Self {
        Self {
            name: value.name,
            env: profiles::redact_env_for_response(&value.env),
        }
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ProfilesResponse {
    pub profiles: Vec<ProfileView>,
    /// Currently active profile name. `"default"` when no profile is applied.
    pub active: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UpsertProfileRequest {
    pub env: HashMap<String, String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct SetActiveProfileRequest {
    pub name: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct CustomModelsResponse {
    pub models: Vec<ModelCatalogEntry>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UpsertCustomModelRequest {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[schema(as = ClaudeCodeSuccessResponse)]
pub struct SuccessResponse {
    pub ok: bool,
}

#[utoipa::path(
    get,
    path = "/api/claude-code/profiles",
    responses((status = 200, body = ProfilesResponse))
)]
pub async fn list_profiles_handler() -> Result<Json<ProfilesResponse>, AppError> {
    let profiles = profiles::list_profiles();
    let active = profiles::get_active_profile_name();
    Ok(Json(ProfilesResponse {
        profiles: profiles.into_iter().map(ProfileView::from).collect(),
        active,
    }))
}

#[utoipa::path(
    put,
    path = "/api/claude-code/profiles/{name}",
    params(("name" = String, Path,)),
    request_body = UpsertProfileRequest,
    responses((status = 200, body = ProfileView))
)]
pub async fn upsert_profile_handler(
    Path(name): Path<String>,
    Json(body): Json<UpsertProfileRequest>,
) -> Result<Json<ProfileView>, AppError> {
    let profile = profiles::upsert_profile(&name, &body.env).await?;
    Ok(Json(ProfileView::from(profile)))
}

#[utoipa::path(
    delete,
    path = "/api/claude-code/profiles/{name}",
    params(("name" = String, Path,)),
    responses((status = 200, body = SuccessResponse))
)]
pub async fn delete_profile_handler(
    Path(name): Path<String>,
) -> Result<Json<SuccessResponse>, AppError> {
    profiles::delete_profile(&name).await?;
    Ok(Json(SuccessResponse { ok: true }))
}

#[utoipa::path(
    put,
    path = "/api/claude-code/profiles/active",
    request_body = SetActiveProfileRequest,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn set_active_profile_handler(
    Json(body): Json<SetActiveProfileRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    profiles::set_active_profile(&body.name).await?;
    Ok(Json(SuccessResponse { ok: true }))
}

#[utoipa::path(
    get,
    path = "/api/claude-code/custom-models",
    responses((status = 200, body = CustomModelsResponse))
)]
pub async fn list_custom_models_handler(
    State(state): State<AppState>,
) -> Result<Json<CustomModelsResponse>, AppError> {
    let models = custom_models::list_custom_models(&state.read_pool).await?;
    Ok(Json(CustomModelsResponse { models }))
}

#[utoipa::path(
    put,
    path = "/api/claude-code/custom-models/{model_id}",
    params(("model_id" = String, Path,)),
    request_body = UpsertCustomModelRequest,
    responses((status = 200, body = ModelCatalogEntry))
)]
pub async fn upsert_custom_model_handler(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
    Json(body): Json<UpsertCustomModelRequest>,
) -> Result<Json<ModelCatalogEntry>, AppError> {
    let entry = custom_models::upsert_custom_model(
        &state.write_pool,
        &model_id,
        &body.label,
        body.description.as_deref(),
    )
    .await?;
    Ok(Json(entry))
}

#[utoipa::path(
    delete,
    path = "/api/claude-code/custom-models/{model_id}",
    params(("model_id" = String, Path,)),
    responses((status = 200, body = SuccessResponse))
)]
pub async fn delete_custom_model_handler(
    State(state): State<AppState>,
    Path(model_id): Path<String>,
) -> Result<Json<SuccessResponse>, AppError> {
    custom_models::delete_custom_model(&state.write_pool, &model_id).await?;
    Ok(Json(SuccessResponse { ok: true }))
}

pub fn claude_code_router() -> Router<AppState> {
    Router::new()
        .route("/api/claude-code/profiles", get(list_profiles_handler))
        .route(
            "/api/claude-code/profiles/active",
            put(set_active_profile_handler),
        )
        .route(
            "/api/claude-code/profiles/{name}",
            put(upsert_profile_handler).delete(delete_profile_handler),
        )
        .route(
            "/api/claude-code/custom-models",
            get(list_custom_models_handler),
        )
        .route(
            "/api/claude-code/custom-models/{model_id}",
            put(upsert_custom_model_handler).delete(delete_custom_model_handler),
        )
}
