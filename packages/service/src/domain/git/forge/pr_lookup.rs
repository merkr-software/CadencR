//! Resolve one pull request of a conversation's repository by number — what
//! the composer needs to turn a pasted PR link into a context chip (title,
//! branches) and offer its branch as the first prompt's base.

use axum::extract::{Json, Query, State};
use serde::Deserialize;
use utoipa::IntoParams;

use super::auth::forge_to_app_error;
use super::provider::PrSummary;
use super::repository::feature_forge_context;
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Deserialize, IntoParams)]
pub struct PrLookupParams {
    pub feature_id: i64,
    pub pr_number: u64,
}

#[utoipa::path(get, path = "/api/git/pr/lookup", params(PrLookupParams), responses((status = 200, body = PrSummary)))]
pub async fn lookup_feature_repo_pr(
    State(state): State<AppState>,
    Query(params): Query<PrLookupParams>,
) -> Result<Json<PrSummary>, AppError> {
    let forge = feature_forge_context(&state, params.feature_id).await?;
    let pr = forge
        .provider
        .get_pr(&forge.context, params.pr_number)
        .await
        .map_err(|error| forge_to_app_error(error))?;
    Ok(Json(pr))
}
