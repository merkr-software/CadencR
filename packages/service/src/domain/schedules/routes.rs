use axum::extract::{Json, Path, Query, State};
use axum::routing::{get, post, put};
use axum::Router;
use serde::Deserialize;

use super::models::{
    SaveScheduleRequest, Schedule, ScheduleDeleted, ScheduleRunResult, SetScheduleEnabledRequest,
};
use super::repository::{self, ScheduleFilter};
use super::service;
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListSchedulesParams {
    /// Only schedules targeting this conversation.
    pub feature_id: Option<i64>,
    /// Only schedules belonging to this project, whichever target kind they use.
    pub project_id: Option<i64>,
}

/// Every configured schedule, soonest first.
#[utoipa::path(
    get,
    path = "/api/schedules",
    params(ListSchedulesParams),
    responses((status = 200, body = Vec<Schedule>))
)]
pub async fn list_schedules_handler(
    State(state): State<AppState>,
    Query(params): Query<ListSchedulesParams>,
) -> Result<Json<Vec<Schedule>>, AppError> {
    Ok(Json(
        repository::list(
            &state.read_pool,
            ScheduleFilter {
                feature_id: params.feature_id,
                project_id: params.project_id,
            },
        )
        .await?,
    ))
}

#[utoipa::path(
    post,
    path = "/api/schedules",
    request_body = SaveScheduleRequest,
    responses((status = 200, body = Schedule))
)]
pub async fn create_schedule_handler(
    State(state): State<AppState>,
    Json(body): Json<SaveScheduleRequest>,
) -> Result<Json<Schedule>, AppError> {
    Ok(Json(repository::insert(&state.write_pool, body).await?))
}

#[utoipa::path(
    get,
    path = "/api/schedules/{id}",
    params(("id" = i64, Path,)),
    responses((status = 200, body = Schedule), (status = 404, description = "Schedule not found"))
)]
pub async fn get_schedule_by_id_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Schedule>, AppError> {
    repository::get(&state.read_pool, id)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::NotFound(format!("schedule {id} not found")))
}

/// Replace a schedule's rule. Run history is preserved.
#[utoipa::path(
    put,
    path = "/api/schedules/{id}",
    params(("id" = i64, Path,)),
    request_body = SaveScheduleRequest,
    responses((status = 200, body = Schedule))
)]
pub async fn update_schedule_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SaveScheduleRequest>,
) -> Result<Json<Schedule>, AppError> {
    Ok(Json(repository::update(&state.write_pool, id, body).await?))
}

#[utoipa::path(
    delete,
    path = "/api/schedules/{id}",
    params(("id" = i64, Path,)),
    responses((status = 200, body = ScheduleDeleted))
)]
pub async fn delete_schedule_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ScheduleDeleted>, AppError> {
    let deleted = repository::delete(&state.write_pool, id).await?;
    Ok(Json(ScheduleDeleted { deleted }))
}

/// Pause or resume a schedule without losing it.
#[utoipa::path(
    put,
    path = "/api/schedules/{id}/enabled",
    params(("id" = i64, Path,)),
    request_body = SetScheduleEnabledRequest,
    responses((status = 200, body = Schedule))
)]
pub async fn set_schedule_enabled_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SetScheduleEnabledRequest>,
) -> Result<Json<Schedule>, AppError> {
    Ok(Json(
        repository::set_enabled(&state.write_pool, id, body.enabled).await?,
    ))
}

/// Fire a schedule immediately, without disturbing when it next fires.
#[utoipa::path(
    post,
    path = "/api/schedules/{id}/run",
    params(("id" = i64, Path,)),
    responses((status = 200, body = ScheduleRunResult))
)]
pub async fn run_schedule_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ScheduleRunResult>, AppError> {
    Ok(Json(service::run_now(&state, id).await?))
}

pub fn schedules_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/schedules",
            get(list_schedules_handler).post(create_schedule_handler),
        )
        .route(
            "/api/schedules/{id}",
            get(get_schedule_by_id_handler)
                .put(update_schedule_handler)
                .delete(delete_schedule_handler),
        )
        .route(
            "/api/schedules/{id}/enabled",
            put(set_schedule_enabled_handler),
        )
        .route("/api/schedules/{id}/run", post(run_schedule_handler))
}
