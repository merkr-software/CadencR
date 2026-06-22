use axum::extract::{Json, Path, Query, State};
use axum::routing::{get, post, put};
use axum::Router;
use serde::Deserialize;

use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::models::*;
use crate::domain::features::service;
use crate::domain::features::worktree_settings::{
    normalize_feature_setting_value, validate_reuse_branch_for_project,
};
use crate::domain::features::worktree_validation::validate_worktree_mode;
use crate::domain::settings_allowlist;
use crate::domain::terminal::activity::foreground_command_counts_by_feature;
use crate::domain::workflow::ws_sender::{
    send_feature_renamed_envelope, send_feature_updated_envelope,
};
use crate::error::AppError;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListFeaturesParams {
    pub project_id: i64,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ResolveWorkingDirParams {
    pub project_id: i64,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListFeatureActivityParams {
    pub project_id: i64,
    #[serde(default)]
    pub include_archived: bool,
}

#[utoipa::path(get, path = "/api/features",
    params(ListFeaturesParams),
    responses((status = 200, body = Vec<Feature>)))]
pub async fn list_features_handler(
    State(state): State<AppState>,
    Query(params): Query<ListFeaturesParams>,
) -> Result<Json<Vec<Feature>>, AppError> {
    Ok(Json(
        service::list_by_project(&state.read_pool, params.project_id, params.include_archived)
            .await?,
    ))
}

#[utoipa::path(post, path = "/api/features",
    request_body = CreateFeatureRequest,
    responses((status = 200, body = CreateFeatureResponse)))]
pub async fn create_feature_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateFeatureRequest>,
) -> Result<Json<CreateFeatureResponse>, AppError> {
    let (worktree_mode, reuse_branch) =
        validate_worktree_mode(&body.worktree_mode, &body.reuse_branch)?;
    if let Some(branch) = reuse_branch.as_deref() {
        validate_reuse_branch_for_project(&state.read_pool, body.project_id, branch).await?;
    }
    let created = service::create_feature_with_worktree(
        &state.write_pool,
        body.project_id,
        body.title,
        body.type_,
        worktree_mode,
        reuse_branch,
        None,
    )
    .await?;
    // Tell every connected client (including remote devices) to refresh their
    // sidebar feature lists so the new conversation appears without a manual
    // refresh.
    state.feature_events_tx.emit(
        created.id,
        Some(body.project_id),
        FeatureEventAction::Created,
    );
    Ok(Json(created))
}

#[utoipa::path(get, path = "/api/features/pinned",
    responses((status = 200, body = Vec<Feature>)))]
pub async fn list_pinned_features_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<Feature>>, AppError> {
    Ok(Json(service::list_pinned(&state.read_pool).await?))
}

#[utoipa::path(get, path = "/api/features/{id}",
    params(("id" = i64, Path,)),
    responses(
        (status = 200, body = Feature),
        (status = 404, description = "Feature not found"),
    ))]
pub async fn get_feature_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Feature>, AppError> {
    service::get_by_id(&state.read_pool, id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("feature {id} not found")))
}

#[utoipa::path(get, path = "/api/features/activity",
    params(ListFeatureActivityParams),
    responses((status = 200, body = Vec<FeatureActivity>)))]
pub async fn list_feature_activity_handler(
    State(state): State<AppState>,
    Query(params): Query<ListFeatureActivityParams>,
) -> Result<Json<Vec<FeatureActivity>>, AppError> {
    let terminal_counts = foreground_command_counts_by_feature(&state.pty_manager);
    let custom_action_counts = state.custom_action_runs.counts_by_feature().await;
    Ok(Json(
        service::list_activity(
            &state.read_pool,
            params.project_id,
            params.include_archived,
            terminal_counts,
            custom_action_counts,
        )
        .await?,
    ))
}

#[utoipa::path(delete, path = "/api/features/{id}",
    params(("id" = i64, Path,)),
    responses((status = 200, body = SuccessResponse)))]
pub async fn delete_feature_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::delete_feature(&state.write_pool, &state.read_pool, id).await?;
    state
        .feature_events_tx
        .emit(id, None, FeatureEventAction::Deleted);
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(put, path = "/api/features/{id}/title",
    params(("id" = i64, Path,)),
    request_body = UpdateTitleRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn update_feature_title_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateTitleRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::update_title(&state.write_pool, id, &body.title).await?;
    broadcast_title_update(&state, id, &body.title).await;
    Ok(Json(SuccessResponse { success: true }))
}

/// Mirror the envelopes that `auto_name` emits so the frontend treats manual
/// and auto-naming the same way.
async fn broadcast_title_update(state: &AppState, feature_id: i64, title: &str) {
    for sender in state.ws_feature_senders.get_senders(feature_id).await {
        send_feature_renamed_envelope(&sender, feature_id, title);
        send_feature_updated_envelope(&sender, feature_id, &["title"]);
    }
}

#[utoipa::path(put, path = "/api/features/{id}/status",
    params(("id" = i64, Path,)),
    request_body = UpdateStatusRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn update_feature_status_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateStatusRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::update_status(&state.write_pool, id, body.status).await?;
    // Archive/unarchive changes which features the sidebar shows.
    state
        .feature_events_tx
        .emit(id, None, FeatureEventAction::Updated);
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(put, path = "/api/features/{id}/label",
    params(("id" = i64, Path,)),
    request_body = UpdateLabelRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn update_feature_label_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateLabelRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    let normalized = body
        .label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty());
    service::update_label(&state.write_pool, id, normalized).await?;
    broadcast_label_update(&state, id).await;
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(put, path = "/api/features/{id}/pin",
    params(("id" = i64, Path,)),
    request_body = UpdatePinnedRequest,
    responses((status = 200, body = SuccessResponse)))]
pub async fn update_feature_pinned_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdatePinnedRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    service::set_pinned(&state.write_pool, id, body.pinned).await?;
    // Pinning moves a conversation into/out of the sidebar "Pinned" section,
    // so every connected client must refetch its feature lists.
    state
        .feature_events_tx
        .emit(id, None, FeatureEventAction::Updated);
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(get, path = "/api/features/{id}/empty",
    params(("id" = i64, Path,)),
    responses((status = 200, body = IsEmptyResponse)))]
pub async fn is_empty_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<IsEmptyResponse>, AppError> {
    Ok(Json(service::is_empty(&state.read_pool, id).await?))
}

async fn broadcast_label_update(state: &AppState, feature_id: i64) {
    for sender in state.ws_feature_senders.get_senders(feature_id).await {
        send_feature_updated_envelope(&sender, feature_id, &["label"]);
    }
}

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

#[utoipa::path(get, path = "/api/features/{id}/working-dir",
    params(("id" = i64, Path,), ResolveWorkingDirParams),
    responses((status = 200, body = WorkingDirResponse)))]
pub async fn get_working_dir_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<ResolveWorkingDirParams>,
) -> Result<Json<WorkingDirResponse>, AppError> {
    Ok(Json(
        service::resolve_working_dir(&state.read_pool, id, params.project_id).await?,
    ))
}

#[derive(serde::Serialize, utoipa::ToSchema)]
#[schema(as = FeaturesSuccessResponse)]
pub struct SuccessResponse {
    pub success: bool,
}

pub fn features_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/features",
            get(list_features_handler).post(create_feature_handler),
        )
        .route("/api/features/activity", get(list_feature_activity_handler))
        .route("/api/features/pinned", get(list_pinned_features_handler))
        .route(
            "/api/features/{id}",
            get(get_feature_handler).delete(delete_feature_handler),
        )
        .route(
            "/api/features/{id}/title",
            put(update_feature_title_handler),
        )
        .route(
            "/api/features/{id}/status",
            put(update_feature_status_handler),
        )
        .route(
            "/api/features/{id}/label",
            put(update_feature_label_handler),
        )
        .route("/api/features/{id}/pin", put(update_feature_pinned_handler))
        .route("/api/features/{id}/empty", get(is_empty_handler))
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
        .route(
            "/api/features/{id}/working-dir",
            get(get_working_dir_handler),
        )
        .route(
            "/api/features/{id}/auto-name",
            post(crate::domain::features::auto_name_route::auto_name_feature_handler),
        )
}
