use super::{catalog, models::*, service};
use crate::domain::themes::models::{CreateThemeResponse, UserTheme};
use crate::{app_state::AppState, error::AppError};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/themes/managed",
            get(get_managed_themes).post(install_managed_theme),
        )
        .route(
            "/api/themes/managed/catalog",
            get(get_managed_theme_catalog),
        )
        .route(
            "/api/themes/managed/catalog/refresh",
            post(refresh_managed_theme_catalog),
        )
        .route(
            "/api/themes/managed/preview",
            post(preview_managed_theme_package),
        )
        .route(
            "/api/themes/managed/{id}",
            axum::routing::delete(remove_managed_theme),
        )
        .route(
            "/api/themes/managed/{id}/preview",
            get(preview_managed_theme),
        )
        .route("/api/themes/managed/{id}/apply", post(apply_managed_theme))
        .route(
            "/api/themes/managed/{id}/update",
            post(update_managed_theme),
        )
        .route(
            "/api/themes/managed/{id}/duplicate",
            post(duplicate_managed_theme),
        )
        .layer(axum::extract::DefaultBodyLimit::max(
            cadencr_registry_core::MAX_CATALOG_BYTES + 1024 * 1024,
        ))
}
#[utoipa::path(get, path="/api/themes/managed", operation_id="getManagedThemes", responses((status=200, body=Vec<ManagedThemeInventoryEntry>)))]
pub async fn get_managed_themes() -> Result<Json<Vec<ManagedThemeInventoryEntry>>, AppError> {
    Ok(Json(service::inventory().await?))
}
#[utoipa::path(get, path="/api/themes/managed/catalog", operation_id="getManagedThemeCatalog", responses((status=200, body=ManagedThemeCatalogResponse)))]
pub async fn get_managed_theme_catalog() -> Json<ManagedThemeCatalogResponse> {
    Json(catalog::acquire(false).await)
}
#[utoipa::path(post, path="/api/themes/managed/catalog/refresh", operation_id="refreshManagedThemeCatalog", responses((status=200, body=ManagedThemeCatalogResponse)))]
pub async fn refresh_managed_theme_catalog() -> Json<ManagedThemeCatalogResponse> {
    Json(catalog::acquire(true).await)
}
#[utoipa::path(post, path="/api/themes/managed", operation_id="installManagedTheme", request_body=InstallManagedThemeRequest, responses((status=200, body=ManagedThemeInventoryEntry)))]
pub async fn install_managed_theme(
    State(state): State<AppState>,
    Json(body): Json<InstallManagedThemeRequest>,
) -> Result<Json<ManagedThemeInventoryEntry>, AppError> {
    let entry = service::install(body, false).await?;
    notify(&state, &entry.id);
    Ok(Json(entry))
}
#[utoipa::path(post, path="/api/themes/managed/preview", operation_id="previewManagedThemePackage", request_body=InstallManagedThemeRequest, responses((status=200, body=UserTheme)))]
pub async fn preview_managed_theme_package(
    Json(body): Json<InstallManagedThemeRequest>,
) -> Result<Json<UserTheme>, AppError> {
    Ok(Json(service::preview_package(body).await?))
}
#[utoipa::path(get, path="/api/themes/managed/{id}/preview", operation_id="previewManagedTheme", params(("id"=String,Path)), responses((status=200, body=ManagedThemeInventoryEntry)))]
pub async fn preview_managed_theme(
    Path(id): Path<String>,
) -> Result<Json<ManagedThemeInventoryEntry>, AppError> {
    Ok(Json(service::preview(&id)?))
}
#[utoipa::path(post, path="/api/themes/managed/{id}/apply", operation_id="applyManagedTheme", params(("id"=String,Path)), responses((status=200, body=ManagedThemeInventoryEntry)))]
pub async fn apply_managed_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ManagedThemeInventoryEntry>, AppError> {
    let entry = service::apply(&id).await?;
    notify(&state, &id);
    Ok(Json(entry))
}
#[utoipa::path(post, path="/api/themes/managed/{id}/update", operation_id="updateManagedTheme", params(("id"=String,Path)), request_body=InstallManagedThemeRequest, responses((status=200, body=ManagedThemeInventoryEntry)))]
pub async fn update_managed_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<InstallManagedThemeRequest>,
) -> Result<Json<ManagedThemeInventoryEntry>, AppError> {
    if id != body.theme_id {
        return Err(super::archive::invalid("theme update id mismatch"));
    }
    let entry = service::install(body, true).await?;
    notify(&state, &id);
    Ok(Json(entry))
}
#[utoipa::path(delete, path="/api/themes/managed/{id}", operation_id="removeManagedTheme", params(("id"=String,Path)), request_body=RemoveManagedThemeRequest, responses((status=200, body=RemoveManagedThemeResponse)))]
pub async fn remove_managed_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RemoveManagedThemeRequest>,
) -> Result<Json<RemoveManagedThemeResponse>, AppError> {
    let response = service::remove(&id, body.confirm_builtin_fallback).await?;
    notify(&state, &id);
    Ok(Json(response))
}
#[utoipa::path(post, path="/api/themes/managed/{id}/duplicate", operation_id="duplicateManagedTheme", params(("id"=String,Path)), request_body=DuplicateManagedThemeRequest, responses((status=200, body=CreateThemeResponse)))]
pub async fn duplicate_managed_theme(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DuplicateManagedThemeRequest>,
) -> Result<Json<CreateThemeResponse>, AppError> {
    Ok(Json(
        service::duplicate(&state.write_pool, &id, &body.label).await?,
    ))
}

fn notify(state: &AppState, id: &str) {
    // No receivers means no connected renderer, not a failed mutation.
    let _ = state
        .theme_events_tx
        .send(crate::domain::themes::ThemesChangeEvent {
            id: format!("managed:{id}"),
        });
}
