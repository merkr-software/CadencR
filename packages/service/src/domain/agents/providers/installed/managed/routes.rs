use axum::extract::rejection::JsonRejection;
use axum::extract::Path;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::receipt::ManagedRevision;
use super::service::{
    ManagedMutation, ManagedProviderInventoryEntry, ManagedProviderService,
    ManagedProvidersInventory,
};
use super::SignedManagedProviderIndex;
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct InstallManagedProviderRequest {
    pub provider_id: String,
    pub version: String,
    pub index: SignedManagedProviderIndex,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct UpdateManagedProviderRequest {
    pub version: String,
    pub index: SignedManagedProviderIndex,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct RollbackManagedProviderRequest {
    pub version: String,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct SetManagedProviderEnabledRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct RefreshManagedBlocklistResponse {
    pub refreshed: bool,
    pub used_cached_verified_policy: bool,
}

#[utoipa::path(
    get,
    path = "/api/agents/managed-providers",
    responses((status = 200, body = ManagedProvidersInventory))
)]
pub async fn inventory_handler() -> Result<Json<ManagedProvidersInventory>, AppError> {
    Ok(Json(
        ManagedProviderService::production()?.inventory().await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/agents/managed-providers",
    request_body = InstallManagedProviderRequest,
    responses((status = 200, body = ManagedProviderInventoryEntry))
)]
pub async fn install_handler(
    payload: Result<Json<InstallManagedProviderRequest>, JsonRejection>,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    let Json(request) = payload.map_err(json_rejection)?;
    let service = ManagedProviderService::production()?;
    let mutation = service
        .install(&request.provider_id, &request.version, request.index)
        .await?;
    response(&service, &request.provider_id, mutation).await
}

#[utoipa::path(
    post,
    path = "/api/agents/managed-providers/{provider_id}/update",
    params(("provider_id" = String, Path)),
    request_body = UpdateManagedProviderRequest,
    responses((status = 200, body = ManagedProviderInventoryEntry))
)]
pub async fn update_handler(
    Path(provider_id): Path<String>,
    payload: Result<Json<UpdateManagedProviderRequest>, JsonRejection>,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    let Json(request) = payload.map_err(json_rejection)?;
    let service = ManagedProviderService::production()?;
    let mutation = service
        .update(&provider_id, &request.version, request.index)
        .await?;
    response(&service, &provider_id, mutation).await
}

#[utoipa::path(
    post,
    path = "/api/agents/managed-providers/{provider_id}/rollback",
    params(("provider_id" = String, Path)),
    request_body = RollbackManagedProviderRequest,
    responses((status = 200, body = ManagedProviderInventoryEntry))
)]
pub async fn rollback_handler(
    Path(provider_id): Path<String>,
    payload: Result<Json<RollbackManagedProviderRequest>, JsonRejection>,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    let Json(request) = payload.map_err(json_rejection)?;
    let service = ManagedProviderService::production()?;
    let mutation = service
        .rollback(
            &provider_id,
            &ManagedRevision {
                version: request.version,
                digest: request.digest,
            },
        )
        .await?;
    response(&service, &provider_id, mutation).await
}

#[utoipa::path(
    put,
    path = "/api/agents/managed-providers/{provider_id}/enabled",
    params(("provider_id" = String, Path)),
    request_body = SetManagedProviderEnabledRequest,
    responses((status = 200, body = ManagedProviderInventoryEntry))
)]
pub async fn enabled_handler(
    Path(provider_id): Path<String>,
    payload: Result<Json<SetManagedProviderEnabledRequest>, JsonRejection>,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    let Json(request) = payload.map_err(json_rejection)?;
    let service = ManagedProviderService::production()?;
    let mutation = service.set_enabled(&provider_id, request.enabled).await?;
    response(&service, &provider_id, mutation).await
}

#[utoipa::path(
    delete,
    path = "/api/agents/managed-providers/{provider_id}",
    params(("provider_id" = String, Path)),
    responses((status = 200, body = ManagedProviderInventoryEntry))
)]
pub async fn remove_handler(
    Path(provider_id): Path<String>,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    let service = ManagedProviderService::production()?;
    let mutation = service.remove(&provider_id).await?;
    response(&service, &provider_id, mutation).await
}

#[utoipa::path(
    post,
    path = "/api/agents/managed-providers/blocklist/refresh",
    responses((status = 200, body = RefreshManagedBlocklistResponse))
)]
pub async fn refresh_blocklist_handler() -> Result<Json<RefreshManagedBlocklistResponse>, AppError>
{
    let refreshed = ManagedProviderService::production()?
        .refresh_blocklist()
        .await?;
    Ok(Json(RefreshManagedBlocklistResponse {
        refreshed,
        used_cached_verified_policy: !refreshed,
    }))
}

pub fn inventory_router() -> Router<AppState> {
    Router::new().route("/api/agents/managed-providers", get(inventory_handler))
}

pub fn lifecycle_router() -> Router<AppState> {
    Router::new()
        .route("/api/agents/managed-providers", post(install_handler))
        .route(
            "/api/agents/managed-providers/blocklist/refresh",
            post(refresh_blocklist_handler),
        )
        .route(
            "/api/agents/managed-providers/{provider_id}/update",
            post(update_handler),
        )
        .route(
            "/api/agents/managed-providers/{provider_id}/rollback",
            post(rollback_handler),
        )
        .route(
            "/api/agents/managed-providers/{provider_id}/enabled",
            put(enabled_handler),
        )
        .route(
            "/api/agents/managed-providers/{provider_id}",
            delete(remove_handler),
        )
}

async fn response(
    service: &ManagedProviderService,
    provider_id: &str,
    mutation: ManagedMutation,
) -> Result<Json<ManagedProviderInventoryEntry>, AppError> {
    if mutation.state.provider_id != provider_id
        || mutation
            .receipt
            .as_ref()
            .is_some_and(|receipt| receipt.agent.id != provider_id)
    {
        return Err(AppError::Internal(
            "managed mutation returned mismatched provider identity".into(),
        ));
    }
    let entry = service.inventory_entry(provider_id).await?;
    Ok(Json(entry))
}

fn json_rejection(rejection: JsonRejection) -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "MANAGED_REQUEST_INVALID",
        rejection.body_text(),
    )
}
