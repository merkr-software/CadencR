use axum::extract::{Json, Path, State};

use crate::app_state::AppState;
use crate::domain::features::routes::SuccessResponse;
use crate::domain::features::service;
use crate::domain::ws_session::auto_name;
use crate::error::AppError;

/// Trigger auto-naming for a feature on demand. Requires at least one user
/// message, then waits for the rename to finish so callers get visible HTTP
/// loading/error state even when no WebSocket client is connected.
///
/// We deliberately allow this on default titles ("Session N", "Untitled
/// Feature") — that's the exact case where the initial implicit auto-naming
/// silently failed and the user wants to retry from the title context menu.
#[utoipa::path(post, path = "/api/features/{id}/auto-name",
    params(("id" = i64, Path,)),
    responses((status = 200, body = SuccessResponse)))]
pub async fn auto_name_feature_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<SuccessResponse>, AppError> {
    let Some(_permit) = state.auto_name_runs.try_acquire(feature_id) else {
        return Err(AppError::Conflict(format!(
            "auto-rename is already running for feature {feature_id}"
        )));
    };

    run_auto_rename(&state, feature_id).await
}

async fn run_auto_rename(
    state: &AppState,
    feature_id: i64,
) -> Result<Json<SuccessResponse>, AppError> {
    let cwd = service::get_feature_cwd(&state.read_pool, feature_id).await?;
    let user_input = auto_name::get_last_user_message(&state.read_pool, feature_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("no user message available for auto-rename".into()))?;
    let senders = state.ws_feature_senders.get_senders(feature_id).await;
    let title = auto_name::force_auto_name_feature_for_senders(
        state.write_pool.clone(),
        feature_id,
        user_input,
        cwd,
        senders,
    )
    .await;
    if title.is_none() {
        return Err(AppError::internal("failed to auto-rename feature"));
    }

    Ok(Json(SuccessResponse { success: true }))
}
