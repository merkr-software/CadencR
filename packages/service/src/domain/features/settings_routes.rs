//! A conversation's own settings: the free-form feature settings and the
//! model and provider it runs with.

use axum::extract::{Json, Path, State};
use axum::routing::get;
use axum::Router;

use super::models::*;
use super::routes::SuccessResponse;
use super::service;
use super::worktree_settings::normalize_feature_setting_value;
use crate::app_state::AppState;
use crate::domain::settings_allowlist;
use crate::error::AppError;

#[utoipa::path(get, path = "/api/features/{id}/settings",
    params(("id" = i64, Path,)),
    responses((status = 200, body = Vec<FeatureSetting>)))]
pub async fn get_feature_settings_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<FeatureSetting>>, AppError> {
    Ok(Json(
        service::get_feature_settings(&state.read_pool, id).await?,
    ))
}

#[utoipa::path(put, path = "/api/features/{id}/settings",
    params(("id" = i64, Path,)),
    request_body = SetFeatureSettingRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn set_feature_setting_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SetFeatureSettingRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    if !settings_allowlist::is_feature_key_allowed(&body.key) {
        return Err(AppError::BadRequest(format!(
            "unknown feature settings key: {}",
            body.key
        )));
    }
    let value =
        normalize_feature_setting_value(&state.read_pool, id, &body.key, &body.value).await?;
    service::set_feature_setting(&state.write_pool, id, &body.key, &value).await?;
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(get, path = "/api/features/{id}/model-settings",
    params(("id" = i64, Path,)),
    responses((status = 200, body = FeatureModelSettings)))]
pub async fn get_feature_model_settings_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<FeatureModelSettings>, AppError> {
    Ok(Json(
        service::get_feature_model_settings(&state.read_pool, id).await?,
    ))
}

#[utoipa::path(put, path = "/api/features/{id}/model-settings",
    params(("id" = i64, Path,)),
    request_body = SetFeatureModelSettingRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn set_feature_model_setting_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SetFeatureModelSettingRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::set_feature_model_setting(&state.write_pool, id, &body.model_type, &body.model)
        .await?;
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(get, path = "/api/features/{id}/provider-settings",
    params(("id" = i64, Path,)),
    responses((status = 200, body = FeatureProviderSettings)))]
pub async fn get_feature_provider_settings_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<FeatureProviderSettings>, AppError> {
    Ok(Json(
        service::get_feature_provider_settings(&state.read_pool, id).await?,
    ))
}

#[utoipa::path(put, path = "/api/features/{id}/provider-settings",
    params(("id" = i64, Path,)),
    request_body = SetFeatureProviderSettingRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn set_feature_provider_setting_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SetFeatureProviderSettingRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::set_feature_provider_setting(
        &state.write_pool,
        id,
        &body.provider_type,
        &body.provider,
    )
    .await?;
    Ok(Json(SuccessResponse { success: true }))
}

pub fn settings_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features/{id}/settings",
            get(get_feature_settings_handler).put(set_feature_setting_handler),
        )
        .route(
            "/api/features/{id}/model-settings",
            get(get_feature_model_settings_handler).put(set_feature_model_setting_handler),
        )
        .route(
            "/api/features/{id}/provider-settings",
            get(get_feature_provider_settings_handler).put(set_feature_provider_setting_handler),
        )
}
