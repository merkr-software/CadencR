mod markdown;
mod output;
pub(super) mod submission;
mod validation;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Json, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};

use super::{
    coded, coded_status, operation_timeout, permit, plan_sha, prepare_context, validate_notes,
};
use crate::app_state::AppState;
use crate::error::AppError;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparePublicationContributionRequest {
    pub bundle_id: String,
    pub release_notes: String,
    pub expected_plan_sha256: String,
    pub confirmed: bool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PreparedPublicationContribution {
    pub project_id: i64,
    pub plugin_id: String,
    pub version: String,
    pub release_url: String,
    pub output_directory: String,
    pub package_path: String,
    pub submission_path: String,
    pub pull_request_path: String,
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/publication-contribution",
    params(("id" = i64, Path,)),
    request_body = PreparePublicationContributionRequest,
    responses(
        (status = 200, body = PreparedPublicationContribution),
        (status = 400), (status = 404), (status = 409), (status = 504)
    )
)]
pub async fn prepare_publication_contribution_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<PreparePublicationContributionRequest>, JsonRejection>,
) -> Result<Json<PreparedPublicationContribution>, AppError> {
    let Json(body) = payload.map_err(|rejection| {
        coded(
            "PUBLICATION_CONTRIBUTION_REQUEST_INVALID",
            rejection.body_text(),
        )
    })?;
    if !body.confirmed {
        return Err(coded(
            "PUBLICATION_CONTRIBUTION_CONFIRMATION_REQUIRED",
            "local contribution preparation must be explicitly confirmed",
        ));
    }
    validate_notes(&body.release_notes)?;
    let permit = permit()?;
    operation_timeout(prepare(state, project_id, body, permit)).await
}

async fn prepare(
    state: AppState,
    project_id: i64,
    body: PreparePublicationContributionRequest,
    permit: tokio::sync::SemaphorePermit<'static>,
) -> Result<Json<PreparedPublicationContribution>, AppError> {
    let mut prepared = prepare_context(
        &state,
        project_id,
        body.bundle_id,
        body.release_notes,
        permit,
    )
    .await?;
    let actual = plan_sha(
        &prepared.local.plan,
        &prepared.inspection.account,
        prepared.inspection.repository_id,
    )?;
    if body.expected_plan_sha256 != actual {
        return Err(coded_status(
            StatusCode::CONFLICT,
            "PUBLICATION_CONTRIBUTION_PLAN_CHANGED",
            "publication plan changed; preview the release again",
        ));
    }
    let documents = submission::build(&prepared.local, &prepared.inspection.account)?;
    let expectation =
        super::remote::GitHubReleaseExpectation::from_request(&prepared.request(&actual));
    prepared.local.archive = axum::body::Bytes::new();
    prepared.local.metadata = axum::body::Bytes::new();
    let published =
        super::github::verify_published_publication_release(&prepared.token, expectation).await?;
    let plugin_id = prepared.local.plan.plugin_id.clone();
    let version = prepared.local.plan.version.clone();
    let root =
        crate::domain::settings_store::dir::sibling_dir("provider-publication-contributions");
    let permit = prepared._permit;
    let (written, _permit) =
        tokio::task::spawn_blocking(move || (output::write(&root, project_id, documents), permit))
            .await
            .map_err(|error| {
                AppError::Internal(format!("publication contribution writer failed: {error}"))
            })?;
    let written = written?;
    Ok(Json(PreparedPublicationContribution {
        project_id,
        plugin_id,
        version,
        release_url: published.release_url,
        output_directory: written.output_directory,
        package_path: written.package_path,
        submission_path: written.submission_path,
        pull_request_path: written.pull_request_path,
    }))
}

pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/projects/{id}/publication-contribution",
        post(prepare_publication_contribution_handler),
    )
}
