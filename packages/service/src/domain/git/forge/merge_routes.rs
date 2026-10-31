//! Approval and merge endpoints for a conversation's proposals.

use axum::extract::{Json, Query, State};
use axum::routing::get;
use axum::Router;

use super::auth::forge_to_app_error;
use super::merging::{
    validate_merge, PrMergeCancelResponse, PrMergeRequest, PrMergeResponse, PrMergeStatus,
};
use super::poller::{refresh_all, request_refresh};
use super::pr_lookup::PrLookupParams;
use super::provider::PrSummary;
use super::repository::{feature_forge_context, FeatureForge};
use super::routes::{conversation_pr, refresh_if_stale};
use crate::app_state::AppState;
use crate::error::AppError;

#[utoipa::path(get, path = "/api/git/pr/merge-status", params(PrLookupParams), responses((status = 200, body = PrMergeStatus)))]
pub async fn get_pr_merge_status_handler(
    State(state): State<AppState>,
    Query(params): Query<PrLookupParams>,
) -> Result<Json<PrMergeStatus>, AppError> {
    let (forge, pr) = resolve(&state, params.feature_id, params.pr_number, false).await?;
    forge
        .provider
        .merge_status(&forge.context, &pr)
        .await
        .map(Json)
        .map_err(forge_to_app_error)
}

#[utoipa::path(post, path = "/api/git/pr/merge", request_body = PrMergeRequest, responses((status = 200, body = PrMergeResponse)))]
pub async fn post_pr_merge_handler(
    State(state): State<AppState>,
    Json(body): Json<PrMergeRequest>,
) -> Result<Json<PrMergeResponse>, AppError> {
    let (forge, pr) = resolve(&state, body.feature_id, body.pr_number, true).await?;
    // Re-read rather than trust the pane: the button the user clicked was
    // drawn from a status that may be a minute old.
    let status = forge
        .provider
        .merge_status(&forge.context, &pr)
        .await
        .map_err(forge_to_app_error)?;
    let command = validate_merge(&status, &body).map_err(AppError::Conflict)?;
    let response = forge
        .provider
        .merge(&forge.context, &pr, &command, &status)
        .await
        .map_err(forge_to_app_error)?;
    request_refresh(&state);
    Ok(Json(response))
}

#[utoipa::path(delete, path = "/api/git/pr/merge", params(PrLookupParams), responses((status = 200, body = PrMergeCancelResponse)))]
pub async fn delete_pr_merge_handler(
    State(state): State<AppState>,
    Query(params): Query<PrLookupParams>,
) -> Result<Json<PrMergeCancelResponse>, AppError> {
    let (forge, pr) = resolve(&state, params.feature_id, params.pr_number, true).await?;
    forge
        .provider
        .cancel_merge(&forge.context, &pr)
        .await
        .map_err(forge_to_app_error)?;
    request_refresh(&state);
    Ok(Json(PrMergeCancelResponse { cancelled: true }))
}

pub fn merge_router() -> Router<AppState> {
    Router::new()
        .route("/api/git/pr/merge-status", get(get_pr_merge_status_handler))
        .route(
            "/api/git/pr/merge",
            axum::routing::post(post_pr_merge_handler).delete(delete_pr_merge_handler),
        )
}

/// The feature's forge and the proposal to act on — only ever one of the
/// conversation's own. A write first brings a stale snapshot up to date; the
/// pane's status poll only fills a missing one (right after a restart) and
/// otherwise trusts the background poller, rather than forcing a refresh of
/// every repository each time.
async fn resolve(
    state: &AppState,
    feature_id: i64,
    pr_number: u64,
    writes: bool,
) -> Result<(FeatureForge, PrSummary), AppError> {
    if writes {
        refresh_if_stale(state, feature_id).await?;
    } else if state.forge_status.get(feature_id).await.is_none() {
        refresh_all(state).await?;
    }
    let snapshot = state
        .forge_status
        .get(feature_id)
        .await
        .ok_or_else(|| AppError::NotFound(format!("Feature not found: {feature_id}")))?;
    let pr = conversation_pr(&snapshot, pr_number)?;
    let forge = feature_forge_context(state, feature_id).await?;
    Ok((forge, pr))
}
