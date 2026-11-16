use axum::extract::{Json, Path, State};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::domain::settings_allowlist;
use crate::domain::settings_store::{self, SettingWarning};
use crate::domain::workspace::models::*;
use crate::domain::workspace::service;
use crate::error::AppError;

#[derive(Serialize, utoipa::ToSchema)]
pub struct SettingValueResponse {
    pub value: Option<String>,
}

/// The raw settings document plus its on-disk path and any non-blocking
/// warnings (unknown keys, invalid values). Shared by the global and project
/// "Edit JSON" / "Copy configuration path" surfaces.
#[derive(Serialize, utoipa::ToSchema)]
pub struct SettingsFileResponse {
    pub path: String,
    pub content: String,
    pub warnings: Vec<SettingWarning>,
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct WriteSettingsFileRequest {
    pub content: String,
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct WriteSettingsFileResponse {
    pub warnings: Vec<SettingWarning>,
}

#[utoipa::path(get, path = "/api/workspace/settings-file", responses((status = 200, body = SettingsFileResponse)))]
pub async fn get_settings_file_handler() -> Result<Json<SettingsFileResponse>, AppError> {
    let (path, content, warnings) = settings_store::global_read_for_edit();
    Ok(Json(SettingsFileResponse {
        path: path.display().to_string(),
        content,
        warnings,
    }))
}

#[utoipa::path(put, path = "/api/workspace/settings-file", request_body = WriteSettingsFileRequest, responses((status = 200, body = WriteSettingsFileResponse)))]
pub async fn put_settings_file_handler(
    Json(body): Json<WriteSettingsFileRequest>,
) -> Result<Json<WriteSettingsFileResponse>, AppError> {
    let warnings = settings_store::global_write_content(&body.content).await?;
    Ok(Json(WriteSettingsFileResponse { warnings }))
}

#[utoipa::path(get, path = "/api/workspace/settings", responses((status = 200, body = Vec<Setting>)))]
pub async fn list_settings_handler(
    State(state): State<AppState>,
) -> Result<Json<Vec<Setting>>, AppError> {
    Ok(Json(service::list_settings(&state.read_pool).await?))
}

#[utoipa::path(get, path = "/api/workspace/settings/{key}", params(("key" = String, Path,)), responses((status = 200, body = SettingValueResponse)))]
pub async fn get_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<SettingValueResponse>, AppError> {
    let value = service::get_setting(&state.read_pool, &key).await?;
    Ok(Json(SettingValueResponse { value }))
}

#[utoipa::path(put, path = "/api/workspace/settings/{key}", params(("key" = String, Path,)), request_body = SetSettingRequest, responses((status = 200, body = SettingValueResponse)))]
pub async fn set_setting_handler(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<SetSettingRequest>,
) -> Result<Json<SettingValueResponse>, AppError> {
    if !settings_allowlist::is_workspace_key_allowed(&key) {
        return Err(AppError::BadRequest(format!(
            "unknown workspace settings key: {key}"
        )));
    }
    service::set_setting(&state.write_pool, &key, &body.value).await?;
    Ok(Json(SettingValueResponse {
        value: Some(body.value),
    }))
}

#[utoipa::path(put, path = "/api/workspace/settings", request_body = SetSettingsBatchRequest, responses((status = 200, body = Vec<Setting>)))]
pub async fn set_workspace_settings_batch_handler(
    Json(body): Json<SetSettingsBatchRequest>,
) -> Result<Json<Vec<Setting>>, AppError> {
    // Reject the whole batch on one unknown key rather than write part of it.
    if let Some(key) = body
        .values
        .keys()
        .find(|key| !settings_allowlist::is_workspace_key_allowed(key))
    {
        return Err(AppError::BadRequest(format!(
            "unknown workspace settings key: {key}"
        )));
    }
    settings_store::global_set_many(&body.values).await?;
    Ok(Json(settings_store::global_list()))
}

#[utoipa::path(get, path = "/api/workspace/model-settings", responses((status = 200, body = ModelSettings)))]
pub async fn get_model_settings_handler(
    State(state): State<AppState>,
) -> Result<Json<ModelSettings>, AppError> {
    Ok(Json(service::get_model_settings(&state.read_pool).await?))
}

#[utoipa::path(get, path = "/api/workspace/provider-settings", responses((status = 200, body = AgentProviderSettings)))]
pub async fn get_provider_settings_handler(
    State(state): State<AppState>,
) -> Result<Json<AgentProviderSettings>, AppError> {
    Ok(Json(
        service::get_provider_settings(&state.read_pool).await?,
    ))
}

#[utoipa::path(put, path = "/api/workspace/model-settings", request_body = SetModelSettingRequest, responses((status = 200, body = SettingValueResponse)))]
pub async fn set_model_setting_handler(
    State(state): State<AppState>,
    Json(body): Json<SetModelSettingRequest>,
) -> Result<Json<SettingValueResponse>, AppError> {
    service::set_model_setting(&state.write_pool, &body.agent_type, &body.model_id).await?;
    Ok(Json(SettingValueResponse {
        value: Some(body.model_id),
    }))
}

#[utoipa::path(put, path = "/api/workspace/provider-settings", request_body = SetProviderSettingRequest, responses((status = 200, body = SettingValueResponse)))]
pub async fn set_provider_setting_handler(
    State(state): State<AppState>,
    Json(body): Json<SetProviderSettingRequest>,
) -> Result<Json<SettingValueResponse>, AppError> {
    service::set_provider_setting(&state.write_pool, &body.agent_type, &body.provider_id).await?;
    Ok(Json(SettingValueResponse {
        value: Some(body.provider_id),
    }))
}

#[derive(Serialize, utoipa::ToSchema)]
pub struct AutoNamePromptResponse {
    /// The built-in auto-naming system prompt, used whenever the workspace
    /// `auto_name_system_prompt` setting is empty.
    pub default_prompt: String,
}

#[utoipa::path(get, path = "/api/workspace/auto-name-prompt", responses((status = 200, body = AutoNamePromptResponse)))]
pub async fn get_auto_name_prompt_handler() -> Json<AutoNamePromptResponse> {
    Json(AutoNamePromptResponse {
        default_prompt: crate::domain::ws_session::auto_name::DEFAULT_AUTO_NAME_SYSTEM_PROMPT
            .to_string(),
    })
}

pub fn workspace_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspace/settings",
            get(list_settings_handler).put(set_workspace_settings_batch_handler),
        )
        .route(
            "/api/workspace/settings-file",
            get(get_settings_file_handler).put(put_settings_file_handler),
        )
        .route(
            "/api/workspace/settings/{key}",
            get(get_setting_handler).put(set_setting_handler),
        )
        .route(
            "/api/workspace/model-settings",
            get(get_model_settings_handler).put(set_model_setting_handler),
        )
        .route(
            "/api/workspace/provider-settings",
            get(get_provider_settings_handler).put(set_provider_setting_handler),
        )
        .route(
            "/api/workspace/auto-name-prompt",
            get(get_auto_name_prompt_handler),
        )
}
