use axum::extract::{Json, Path, State};
use axum::routing::{get, patch, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::error::AppError;

use super::store::{self, QueuedPrompt};
use super::{acceptance, delivery};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct QueuePromptRequest {
    pub content: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PromptQueueOkResponse {
    pub ok: bool,
}

#[utoipa::path(get, path = "/api/sessions/{session_id}/prompt-queue",
    params(("session_id" = i64, Path,)),
    responses((status = 200, body = Vec<QueuedPrompt>)))]
pub async fn list_session_prompt_queue(
    State(state): State<AppState>,
    Path(session_id): Path<i64>,
) -> Result<Json<Vec<QueuedPrompt>>, AppError> {
    Ok(Json(store::list_open(&state.read_pool, session_id).await?))
}

#[utoipa::path(post, path = "/api/sessions/{session_id}/prompt-queue",
    params(("session_id" = i64, Path,)),
    request_body = QueuePromptRequest,
    responses((status = 200, body = QueuedPrompt)))]
pub async fn enqueue_session_prompt(
    State(state): State<AppState>,
    Path(session_id): Path<i64>,
    Json(body): Json<QueuePromptRequest>,
) -> Result<Json<QueuedPrompt>, AppError> {
    let prompt = acceptance::enqueue(&state, session_id, &body.content).await?;
    Ok(Json(prompt))
}

#[utoipa::path(patch, path = "/api/sessions/{session_id}/prompt-queue/{id}",
    params(("session_id" = i64, Path,), ("id" = i64, Path,)),
    request_body = QueuePromptRequest,
    responses((status = 200, body = QueuedPrompt)))]
pub async fn update_session_queued_prompt(
    State(state): State<AppState>,
    Path((session_id, id)): Path<(i64, i64)>,
    Json(body): Json<QueuePromptRequest>,
) -> Result<Json<QueuedPrompt>, AppError> {
    let prompt = store::update_content(
        &state.write_pool,
        session_id,
        id,
        acceptance::validated(&body.content)?,
    )
    .await?;
    super::notify_changed(&state, session_id);
    Ok(Json(prompt))
}

#[utoipa::path(delete, path = "/api/sessions/{session_id}/prompt-queue/{id}",
    params(("session_id" = i64, Path,), ("id" = i64, Path,)),
    responses((status = 200, body = PromptQueueOkResponse)))]
pub async fn delete_session_queued_prompt(
    State(state): State<AppState>,
    Path((session_id, id)): Path<(i64, i64)>,
) -> Result<Json<PromptQueueOkResponse>, AppError> {
    store::cancel(&state.write_pool, session_id, id).await?;
    super::notify_changed(&state, session_id);
    Ok(Json(PromptQueueOkResponse { ok: true }))
}

#[utoipa::path(post, path = "/api/sessions/{session_id}/prompt-queue/{id}/send",
    params(("session_id" = i64, Path,), ("id" = i64, Path,)),
    responses((status = 200, body = PromptQueueOkResponse)))]
pub async fn send_session_queued_prompt_now(
    State(state): State<AppState>,
    Path((session_id, id)): Path<(i64, i64)>,
) -> Result<Json<PromptQueueOkResponse>, AppError> {
    delivery::send_now(&state, session_id, id).await?;
    Ok(Json(PromptQueueOkResponse { ok: true }))
}

pub fn prompt_queue_router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sessions/{session_id}/prompt-queue",
            get(list_session_prompt_queue).post(enqueue_session_prompt),
        )
        .route(
            "/api/sessions/{session_id}/prompt-queue/{id}",
            patch(update_session_queued_prompt).delete(delete_session_queued_prompt),
        )
        .route(
            "/api/sessions/{session_id}/prompt-queue/{id}/send",
            post(send_session_queued_prompt_now),
        )
}
