use axum::extract::{Json, Path, State};
use axum::routing::{get, post};
use axum::Router;

use super::models::{
    CreateFeatureLayoutRequest, FeatureLayout, SuccessResponse, UpdateFeatureLayoutRequest,
};
use super::{repository, service};
use crate::app_state::AppState;
use crate::error::AppError;

#[utoipa::path(
    get,
    path = "/api/feature-layouts",
    responses((status = 200, body = Vec<FeatureLayout>))
)]
pub async fn list_layouts_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<FeatureLayout>>, AppError> {
    Ok(Json(repository::list(&state.read_pool).await?))
}

#[utoipa::path(
    post,
    path = "/api/feature-layouts",
    request_body = CreateFeatureLayoutRequest,
    responses((status = 200, body = FeatureLayout))
)]
pub async fn create_layout_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateFeatureLayoutRequest>,
) -> Result<Json<FeatureLayout>, AppError> {
    service::validate_name(&body.name)?;
    service::validate_config(&body.config)?;
    let id = repository::insert(&state.write_pool, body.name.trim(), &body.config).await?;
    let row = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::internal("inserted layout vanished"))?;
    Ok(Json(row))
}

#[utoipa::path(
    put,
    path = "/api/feature-layouts/{id}",
    params(("id" = i64, Path,)),
    request_body = UpdateFeatureLayoutRequest,
    responses((status = 200, body = FeatureLayout))
)]
pub async fn update_layout_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateFeatureLayoutRequest>,
) -> Result<Json<FeatureLayout>, AppError> {
    repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Feature layout {id} not found")))?;

    if let Some(ref name) = body.name {
        service::validate_name(name)?;
    }
    if let Some(ref config) = body.config {
        service::validate_config(config)?;
    }

    repository::update(
        &state.write_pool,
        id,
        body.name.as_deref().map(str::trim),
        body.config.as_deref(),
    )
    .await?;

    let row = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::internal("updated layout vanished"))?;
    Ok(Json(row))
}

#[utoipa::path(
    delete,
    path = "/api/feature-layouts/{id}",
    params(("id" = i64, Path,)),
    responses((status = 200, body = SuccessResponse))
)]
pub async fn delete_layout_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<SuccessResponse>, AppError> {
    repository::delete(&state.write_pool, id).await?;
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(
    post,
    path = "/api/feature-layouts/{id}/set-default",
    params(("id" = i64, Path,)),
    responses((status = 200, body = FeatureLayout))
)]
pub async fn set_default_layout_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<FeatureLayout>, AppError> {
    repository::set_default(&state.write_pool, id).await?;
    let row = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::internal("default layout vanished"))?;
    Ok(Json(row))
}

pub fn feature_layouts_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/feature-layouts",
            get(list_layouts_handler).post(create_layout_handler),
        )
        .route(
            "/api/feature-layouts/{id}",
            axum::routing::put(update_layout_handler).delete(delete_layout_handler),
        )
        .route(
            "/api/feature-layouts/{id}/set-default",
            post(set_default_layout_handler),
        )
}
