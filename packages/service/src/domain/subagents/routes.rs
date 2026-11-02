use axum::extract::{Json, Path, State};
use axum::routing::get;
use axum::Router;

use crate::app_state::AppState;
use crate::error::AppError;

use super::list::list_for_feature;
use super::model::SubagentRun;

/// The sub-agents the feature's conversations launched, newest first.
#[utoipa::path(get, path = "/api/features/{feature_id}/subagents",
    params(("feature_id" = i64, Path,)),
    responses((status = 200, body = Vec<SubagentRun>)))]
pub async fn list_feature_subagents(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
) -> Result<Json<Vec<SubagentRun>>, AppError> {
    Ok(Json(list_for_feature(&state.read_pool, feature_id).await?))
}

pub fn subagents_router() -> Router<AppState> {
    Router::new().route(
        "/api/features/{feature_id}/subagents",
        get(list_feature_subagents),
    )
}
