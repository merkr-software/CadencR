use axum::extract::{Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::error::AppError;

use super::profiles::{self, CodexProfileView, ProfileDraft, ProfileUpdate, ValidationResult};
use super::PROVIDER_ID;

#[derive(Debug, Serialize, ToSchema)]
#[schema(as = CodexProfilesResponse)]
pub struct ProfilesResponse {
    pub profiles: Vec<CodexProfileView>,
    pub active_profile_id: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[schema(as = CodexSetActiveProfileRequest)]
pub struct SetActiveProfileRequest {
    pub profile_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[schema(as = CodexSuccessResponse)]
pub struct SuccessResponse {
    pub ok: bool,
}

#[utoipa::path(get, path = "/api/codex/profiles", operation_id = "codex_list_profiles", responses((status = 200, body = ProfilesResponse)))]
pub async fn list_profiles_handler() -> Result<Json<ProfilesResponse>, AppError> {
    Ok(Json(response()?))
}

#[utoipa::path(post, path = "/api/codex/profiles", operation_id = "codex_create_profile", request_body = ProfileDraft, responses((status = 200, body = CodexProfileView)))]
pub async fn create_profile_handler(
    Json(body): Json<ProfileDraft>,
) -> Result<Json<CodexProfileView>, AppError> {
    Ok(Json(profiles::create(body).await?))
}

#[utoipa::path(put, path = "/api/codex/profiles/{id}", operation_id = "codex_update_profile", params(("id" = String, Path)), request_body = ProfileUpdate, responses((status = 200, body = CodexProfileView)))]
pub async fn update_profile_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ProfileUpdate>,
) -> Result<Json<CodexProfileView>, AppError> {
    let referenced = profile_reference_counts(&state, &id).await? != (0, 0);
    let updated = profiles::update(&id, body, !referenced).await?;
    crate::domain::agents::extensions::forget_inventories();
    Ok(Json(updated))
}

#[utoipa::path(delete, path = "/api/codex/profiles/{id}", operation_id = "codex_delete_profile", params(("id" = String, Path)), responses((status = 200, body = SuccessResponse)))]
pub async fn delete_profile_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SuccessResponse>, AppError> {
    reject_referenced_profile(&state, &id).await?;
    profiles::delete(&id).await?;
    crate::domain::agents::extensions::forget_inventories();
    Ok(Json(SuccessResponse { ok: true }))
}

#[utoipa::path(put, path = "/api/codex/profiles/active", operation_id = "codex_set_active_profile", request_body = SetActiveProfileRequest, responses((status = 200, body = ProfilesResponse)))]
pub async fn set_active_profile_handler(
    Json(body): Json<SetActiveProfileRequest>,
) -> Result<Json<ProfilesResponse>, AppError> {
    profiles::set_active(body.profile_id.as_deref()).await?;
    crate::domain::agents::extensions::forget_inventories();
    Ok(Json(response()?))
}

#[utoipa::path(post, path = "/api/codex/profiles/validate", operation_id = "codex_validate_profile", request_body = ProfileDraft, responses((status = 200, body = ValidationResult)))]
pub async fn validate_profile_handler(Json(body): Json<ProfileDraft>) -> Json<ValidationResult> {
    Json(profiles::validate_draft(body))
}

pub fn codex_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/codex/profiles",
            get(list_profiles_handler).post(create_profile_handler),
        )
        .route(
            "/api/codex/profiles/active",
            put(set_active_profile_handler),
        )
        .route(
            "/api/codex/profiles/validate",
            post(validate_profile_handler),
        )
        .route(
            "/api/codex/profiles/{id}",
            put(update_profile_handler).delete(delete_profile_handler),
        )
}

fn response() -> Result<ProfilesResponse, AppError> {
    Ok(ProfilesResponse {
        profiles: profiles::views()?,
        active_profile_id: profiles::active_id(),
    })
}

async fn reject_referenced_profile(state: &AppState, id: &str) -> Result<(), AppError> {
    let (session_count, schedule_count) = profile_reference_counts(state, id).await?;
    if session_count + schedule_count > 0 {
        return Err(AppError::Conflict(format!(
            "Codex profile '{id}' is referenced by {session_count} session(s) and {schedule_count} schedule(s)"
        )));
    }
    Ok(())
}

async fn profile_reference_counts(state: &AppState, id: &str) -> Result<(i64, i64), AppError> {
    let session_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_sessions WHERE runtime_provider = ? AND profile = ?",
    )
    .bind(PROVIDER_ID)
    .bind(id)
    .fetch_one(&state.read_pool)
    .await?;
    let schedule_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM schedules WHERE provider = ? AND profile = ?")
            .bind(PROVIDER_ID)
            .bind(id)
            .fetch_one(&state.read_pool)
            .await?;
    Ok((session_count, schedule_count))
}
