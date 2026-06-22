use axum::extract::{Json, Path, State};
use axum::routing::get;
use axum::Router;

use super::models::{ScheduledMessage, ScheduledMessageDeleted, SetScheduledMessageRequest};
use super::repository;
use crate::app_state::AppState;
use crate::error::AppError;

/// The pending scheduled message for a conversation, or `null` when none is
/// queued.
#[utoipa::path(
    get,
    path = "/api/features/{feature_id}/scheduled-message",
    params(("feature_id" = i64, Path,)),
    responses((status = 200, body = Option<ScheduledMessage>))
)]
pub async fn get_scheduled_message_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<Option<ScheduledMessage>>, AppError> {
    Ok(Json(
        repository::get_pending(&state.read_pool, feature_id).await?,
    ))
}

/// Create or replace the pending scheduled message for a conversation.
#[utoipa::path(
    put,
    path = "/api/features/{feature_id}/scheduled-message",
    params(("feature_id" = i64, Path,)),
    request_body = SetScheduledMessageRequest,
    responses((status = 200, body = ScheduledMessage))
)]
pub async fn set_scheduled_message_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
    Json(body): Json<SetScheduledMessageRequest>,
) -> Result<Json<ScheduledMessage>, AppError> {
    let text = body.text.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("message text is required".into()));
    }
    if body.scheduled_at.trim().is_empty() {
        return Err(AppError::BadRequest("scheduled_at is required".into()));
    }
    if !repository::feature_exists(&state.read_pool, feature_id).await? {
        return Err(AppError::NotFound(format!(
            "feature {feature_id} not found"
        )));
    }

    let row = repository::upsert(&state.write_pool, feature_id, text, &body.scheduled_at).await?;
    Ok(Json(row))
}

/// Cancel the pending scheduled message for a conversation.
#[utoipa::path(
    delete,
    path = "/api/features/{feature_id}/scheduled-message",
    params(("feature_id" = i64, Path,)),
    responses((status = 200, body = ScheduledMessageDeleted))
)]
pub async fn delete_scheduled_message_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<ScheduledMessageDeleted>, AppError> {
    let deleted = repository::cancel(&state.write_pool, feature_id).await?;
    Ok(Json(ScheduledMessageDeleted { deleted }))
}

pub fn scheduled_messages_router() -> Router<AppState> {
    Router::new().route(
        "/api/features/{feature_id}/scheduled-message",
        get(get_scheduled_message_handler)
            .put(set_scheduled_message_handler)
            .delete(delete_scheduled_message_handler),
    )
}
