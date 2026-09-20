mod branch;
#[cfg(test)]
mod fixture;
mod identity;
mod models;
mod plan;
mod state;
mod transport;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Json, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};

use super::{coded, coded_status, operation_timeout, permit, prepare_context, validate_notes};
use crate::app_state::AppState;
use crate::error::AppError;

const REGISTRY: &str = "merkr-software/cadencr-registry";

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreviewPublicationRegistryRequest {
    pub bundle_id: String,
    pub release_notes: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SubmitPublicationRegistryRequest {
    pub bundle_id: String,
    pub release_notes: String,
    pub expected_plan_sha256: String,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct PublicationRegistryPreview {
    pub project_id: i64,
    pub plugin_id: String,
    pub version: String,
    pub bundle_id: String,
    pub release_notes: String,
    pub account: String,
    pub registry_repository: String,
    pub base_branch: String,
    pub base_commit: String,
    pub branch: String,
    pub package_path: String,
    pub submission_path: String,
    pub plan_sha256: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PublicationRegistryResult {
    pub pull_request_url: String,
    pub pull_request_number: u64,
    pub branch: String,
    pub reused: bool,
}

struct PreparedRegistry {
    preview: PublicationRegistryPreview,
    token: String,
    actor_id: u64,
    repository_id: u64,
    documents: super::contribution::submission::Documents,
    transport: transport::Transport,
    _permit: tokio::sync::SemaphorePermit<'static>,
}

#[utoipa::path(post, path = "/api/projects/{id}/publication-registry/preview",
    params(("id" = i64, Path,)), request_body = PreviewPublicationRegistryRequest,
    responses((status = 200, body = PublicationRegistryPreview), (status = 400), (status = 404), (status = 409), (status = 504)))]
pub async fn preview_publication_registry_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<PreviewPublicationRegistryRequest>, JsonRejection>,
) -> Result<Json<PublicationRegistryPreview>, AppError> {
    let Json(body) = payload.map_err(request_error)?;
    validate_notes(&body.release_notes)?;
    let prepared = operation_timeout(prepare(
        &state,
        project_id,
        body.bundle_id,
        body.release_notes,
        permit()?,
    ))
    .await?;
    Ok(Json(prepared.preview))
}

#[utoipa::path(post, path = "/api/projects/{id}/publication-registry",
    params(("id" = i64, Path,)), request_body = SubmitPublicationRegistryRequest,
    responses((status = 200, body = PublicationRegistryResult), (status = 400), (status = 404), (status = 409), (status = 502), (status = 504)))]
pub async fn submit_publication_registry_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<SubmitPublicationRegistryRequest>, JsonRejection>,
) -> Result<Json<PublicationRegistryResult>, AppError> {
    let Json(body) = payload.map_err(request_error)?;
    if !body.confirmed {
        return Err(coded(
            "PUBLICATION_REGISTRY_CONFIRMATION_REQUIRED",
            "registry pull request creation must be explicitly confirmed",
        ));
    }
    validate_notes(&body.release_notes)?;
    operation_timeout(submit(&state, project_id, body, permit()?)).await
}

async fn submit(
    state: &AppState,
    project_id: i64,
    body: SubmitPublicationRegistryRequest,
    permit: tokio::sync::SemaphorePermit<'static>,
) -> Result<Json<PublicationRegistryResult>, AppError> {
    let prepared = prepare(
        state,
        project_id,
        body.bundle_id,
        body.release_notes,
        permit,
    )
    .await?;
    if body.expected_plan_sha256 != prepared.preview.plan_sha256 {
        return Err(coded_status(
            StatusCode::CONFLICT,
            "PUBLICATION_REGISTRY_PLAN_CHANGED",
            "registry plan changed; preview it again",
        ));
    }
    let result = state::submit_with_transport(
        &prepared.transport,
        state::Submission {
            token: &prepared.token,
            preview: &prepared.preview,
            actor_id: prepared.actor_id,
            repository_id: prepared.repository_id,
            package: &prepared.documents.package,
            submission: &prepared.documents.submission,
            pull_request_body: &prepared.documents.markdown,
        },
    )
    .await?;
    Ok(Json(result))
}

async fn prepare(
    state: &AppState,
    project_id: i64,
    bundle_id: String,
    release_notes: String,
    permit: tokio::sync::SemaphorePermit<'static>,
) -> Result<PreparedRegistry, AppError> {
    let mut prepared = prepare_context(state, project_id, bundle_id, release_notes, permit).await?;
    let documents =
        super::contribution::submission::build(&prepared.local, &prepared.inspection.account)?;
    let release_plan = super::plan_sha(
        &prepared.local.plan,
        &prepared.inspection.account,
        prepared.inspection.repository_id,
    )?;
    let expectation =
        super::remote::GitHubReleaseExpectation::from_request(&prepared.request(&release_plan));
    prepared.local.archive = axum::body::Bytes::new();
    prepared.local.metadata = axum::body::Bytes::new();
    super::github::verify_published_publication_release(&prepared.token, expectation).await?;
    let transport = transport::Transport::production()?;
    let remote = state::inspect(&transport, &prepared.token, &documents).await?;
    if remote.account != prepared.inspection.account {
        return Err(conflict(
            "PUBLICATION_REGISTRY_REMOTE_IDENTITY_MISMATCH",
            "GitHub account changed during registry preview",
        ));
    }
    let preview = plan::build(
        &prepared.local.plan,
        &documents,
        &documents.markdown,
        &remote,
    )?;
    Ok(PreparedRegistry {
        preview,
        token: prepared.token,
        actor_id: remote.actor_id,
        repository_id: remote.repository_id,
        documents,
        transport,
        _permit: prepared._permit,
    })
}

fn request_error(error: JsonRejection) -> AppError {
    coded("PUBLICATION_REGISTRY_REQUEST_INVALID", error.body_text())
}

pub(super) fn conflict(code: &'static str, message: impl Into<String>) -> AppError {
    coded_status(StatusCode::CONFLICT, code, message)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{id}/publication-registry/preview",
            post(preview_publication_registry_handler),
        )
        .route(
            "/api/projects/{id}/publication-registry",
            post(submit_publication_registry_handler),
        )
}
