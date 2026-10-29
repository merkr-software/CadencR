use axum::extract::{Json, Path, Query, State};
use axum::routing::{get, post, put};
use axum::Router;
use serde::Deserialize;

use super::models::{
    CreateCustomActionRequest, CustomAction, CustomActionRun, CustomActionVariable,
    ResolvedCommand, RunResponse, Scope, SetCustomActionVariableRequest, SuccessResponse,
    TriggeredBy, UpdateCustomActionRequest,
};
use super::repository;
use super::runner;
use super::service;
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListActionsQuery {
    pub project_id: i64,
    /// Optional feature id to embed `last_run` summaries on each action.
    pub feature_id: Option<i64>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct FeatureIdQuery {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct FeatureIdAndLimitQuery {
    pub feature_id: i64,
    pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------
// Action CRUD
// ---------------------------------------------------------------------------

#[utoipa::path(get, path = "/api/custom-actions", params(ListActionsQuery), responses((status = 200, body = Vec<CustomAction>)))]
pub async fn list_actions_handler(
    State(state): State<AppState>,
    Query(q): Query<ListActionsQuery>,
) -> Result<Json<Vec<CustomAction>>, AppError> {
    Ok(Json(
        repository::list_for_project(&state.read_pool, q.project_id, q.feature_id).await?,
    ))
}

#[utoipa::path(post, path = "/api/custom-actions", request_body = CreateCustomActionRequest, responses((status = 200, body = CustomAction)))]
pub async fn create_action_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateCustomActionRequest>,
) -> Result<Json<CustomAction>, AppError> {
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if body.command.trim().is_empty() {
        return Err(AppError::BadRequest("command is required".into()));
    }
    service::validate_scope(body.scope, body.project_id)?;
    service::validate_icon(body.icon_data.as_deref())?;
    let id = repository::insert(
        &state.write_pool,
        &body.name,
        &body.command,
        body.icon_data.as_deref(),
        body.scope,
        body.project_id,
        body.run_in_terminal.unwrap_or(false),
    )
    .await?;
    let row = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::Internal("inserted action vanished".into()))?;
    Ok(Json(row))
}

#[utoipa::path(put, path = "/api/custom-actions/{id}", params(("id" = i64, Path,)), request_body = UpdateCustomActionRequest, responses((status = 200, body = CustomAction)))]
pub async fn update_action_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateCustomActionRequest>,
) -> Result<Json<CustomAction>, AppError> {
    let existing = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Custom action {id} not found")))?;
    let next_scope = body.scope.unwrap_or(existing.scope);
    // When scope flips to global, force-clear project_id; otherwise honour the
    // explicit project_id if the caller sent one, else leave it alone.
    let next_project_id = match next_scope {
        Scope::Global => None,
        Scope::Project => body.project_id.or(existing.project_id),
    };
    service::validate_scope(next_scope, next_project_id)?;
    service::validate_icon(body.icon_data.as_deref())?;

    repository::update(
        &state.write_pool,
        id,
        body.name.as_deref(),
        body.command.as_deref(),
        body.icon_data
            .as_ref()
            .map(|s| if s.is_empty() { None } else { Some(s.as_str()) }),
        body.scope,
        match (body.scope, body.project_id) {
            (Some(Scope::Global), _) => Some(None),
            (_, Some(pid)) => Some(Some(pid)),
            _ => None,
        },
        body.position,
        body.run_in_terminal,
    )
    .await?;

    let row = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::Internal("updated action vanished".into()))?;
    Ok(Json(row))
}

#[utoipa::path(delete, path = "/api/custom-actions/{id}", params(("id" = i64, Path,)), responses((status = 200, body = SuccessResponse)))]
pub async fn delete_action_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<SuccessResponse>, AppError> {
    // Its schedules go with it (`schedules.custom_action_id` cascades).
    repository::delete(&state.write_pool, id).await?;
    Ok(Json(SuccessResponse { success: true }))
}

#[utoipa::path(get, path = "/api/custom-actions/{id}/variables", params(("id" = i64, Path,), FeatureIdQuery), responses((status = 200, body = Vec<CustomActionVariable>)))]
pub async fn list_variables_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FeatureIdQuery>,
) -> Result<Json<Vec<CustomActionVariable>>, AppError> {
    Ok(Json(
        repository::list_variables(&state.read_pool, id, q.feature_id).await?,
    ))
}

#[utoipa::path(put, path = "/api/custom-actions/{id}/variables", params(("id" = i64, Path,), FeatureIdQuery), request_body = SetCustomActionVariableRequest, responses((status = 200, body = SuccessResponse)))]
pub async fn set_variable_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FeatureIdQuery>,
    Json(body): Json<SetCustomActionVariableRequest>,
) -> Result<Json<SuccessResponse>, AppError> {
    if body.var_name.trim().is_empty() {
        return Err(AppError::BadRequest("var_name is required".into()));
    }
    repository::upsert_variable(
        &state.write_pool,
        id,
        q.feature_id,
        &body.var_name,
        &body.value,
    )
    .await?;
    Ok(Json(SuccessResponse { success: true }))
}

// ---------------------------------------------------------------------------
// Run + history
// ---------------------------------------------------------------------------

#[utoipa::path(post, path = "/api/custom-actions/{id}/run", params(("id" = i64, Path,), FeatureIdQuery), responses((status = 200, body = RunResponse)))]
pub async fn run_action_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FeatureIdQuery>,
) -> Result<Json<RunResponse>, AppError> {
    // Start the run in the background and return its id immediately. Setup
    // errors (missing worktree/variables) still surface synchronously; the
    // command's output and exit code stream into `custom_action_runs` and are
    // read back via `GET /runs`, so a long-running action stays visible after
    // the triggering button/menu closes.
    let run_id = runner::start(&state, id, q.feature_id, TriggeredBy::Manual).await?;
    Ok(Json(RunResponse { run_id }))
}

#[utoipa::path(get, path = "/api/custom-actions/{id}/resolved", params(("id" = i64, Path,), FeatureIdQuery), responses((status = 200, body = ResolvedCommand)))]
pub async fn resolve_command_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FeatureIdQuery>,
) -> Result<Json<ResolvedCommand>, AppError> {
    // Interpolate the command and resolve the feature's working directory the
    // same way a backgrounded run would, so the terminal split runs the exact
    // command the user configured. Setup errors (missing worktree/variables)
    // surface here just as they do for `run`.
    let (command, cwd) = runner::resolve(&state, id, q.feature_id).await?;
    Ok(Json(ResolvedCommand { command, cwd }))
}

#[utoipa::path(get, path = "/api/custom-actions/{id}/runs", params(("id" = i64, Path,), FeatureIdAndLimitQuery), responses((status = 200, body = Vec<CustomActionRun>)))]
pub async fn list_runs_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(q): Query<FeatureIdAndLimitQuery>,
) -> Result<Json<Vec<CustomActionRun>>, AppError> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    Ok(Json(
        repository::list_runs(&state.read_pool, id, q.feature_id, limit).await?,
    ))
}

#[utoipa::path(post, path = "/api/custom-actions/{id}/runs/{run_id}/cancel", params(("id" = i64, Path,), ("run_id" = i64, Path,)), responses((status = 200, body = SuccessResponse)))]
pub async fn cancel_run_handler(
    State(state): State<AppState>,
    // `id` is part of the REST path for consistency; the run id alone is unique.
    Path((_id, run_id)): Path<(i64, i64)>,
) -> Result<Json<SuccessResponse>, AppError> {
    // Interrupt the running command (Ctrl-C, escalating to SIGKILL). 404 when
    // the run already finished between the UI seeing it and this request.
    if !state.custom_action_runs.cancel(run_id).await {
        return Err(AppError::NotFound(format!(
            "Run {run_id} is not currently running"
        )));
    }
    Ok(Json(SuccessResponse { success: true }))
}

pub fn custom_actions_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/custom-actions",
            get(list_actions_handler).post(create_action_handler),
        )
        .route(
            "/api/custom-actions/{id}",
            put(update_action_handler).delete(delete_action_handler),
        )
        .route(
            "/api/custom-actions/{id}/variables",
            get(list_variables_handler).put(set_variable_handler),
        )
        .route("/api/custom-actions/{id}/run", post(run_action_handler))
        .route(
            "/api/custom-actions/{id}/resolved",
            get(resolve_command_handler),
        )
        .route("/api/custom-actions/{id}/runs", get(list_runs_handler))
        .route(
            "/api/custom-actions/{id}/runs/{run_id}/cancel",
            post(cancel_run_handler),
        )
}
