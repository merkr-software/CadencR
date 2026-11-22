use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::error::AppError;

use super::{retention, scheduler};

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArchivedCleanupRunStatus {
    Started,
    AlreadyRunning,
    NothingDue,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ArchivedCleanupRunResponse {
    pub status: ArchivedCleanupRunStatus,
    /// Archived conversations currently eligible under the saved policy.
    pub eligible_features: u64,
}

#[utoipa::path(
    post,
    path = "/api/storage-maintenance/archived-cleanup/run",
    responses(
        (status = 200, body = ArchivedCleanupRunResponse),
        (status = 400, description = "Archived conversation cleanup is disabled")
    )
)]
pub async fn run_archived_cleanup_handler(
    State(state): State<AppState>,
) -> Result<Json<ArchivedCleanupRunResponse>, AppError> {
    let Some(run) = state.storage_maintenance_events_tx.try_begin_run() else {
        return Ok(Json(ArchivedCleanupRunResponse {
            status: ArchivedCleanupRunStatus::AlreadyRunning,
            eligible_features: 0,
        }));
    };

    let Some(eligible_features) = retention::due_feature_count_if_enabled(&state.read_pool).await?
    else {
        return Err(AppError::BadRequest(
            "Enable archived conversation cleanup in Settings first".to_string(),
        ));
    };
    if eligible_features == 0 {
        return Ok(Json(ArchivedCleanupRunResponse {
            status: ArchivedCleanupRunStatus::NothingDue,
            eligible_features,
        }));
    }

    scheduler::spawn_cleanup(
        state.read_pool.clone(),
        state.write_pool.clone(),
        state.storage_maintenance_events_tx.clone(),
        run,
    );
    Ok(Json(ArchivedCleanupRunResponse {
        status: ArchivedCleanupRunStatus::Started,
        eligible_features,
    }))
}

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/storage-maintenance/archived-cleanup/run",
        post(run_archived_cleanup_handler),
    )
}
