pub mod contribution;
mod github;
mod local;
mod plan;
pub mod registry;
mod remote;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Json, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::app_state::AppState;
use crate::domain::git::forge::{forge_to_app_error, host_configs, resolve_credentials};
use crate::domain::git::host::GitHost;
use crate::error::AppError;

use self::remote::GitHubPublishRequest;

const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 384 * 1024;
const MAX_RELEASE_NOTES_BYTES: usize = 16 * 1024;
const OPERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
static RELEASE_OPERATION: Semaphore = Semaphore::const_new(1);

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreviewPublicationReleaseRequest {
    pub bundle_id: String,
    pub release_notes: String,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishPublicationReleaseRequest {
    pub bundle_id: String,
    pub release_notes: String,
    pub expected_plan_sha256: String,
    pub confirmed: bool,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PublicationReleasePreview {
    pub project_id: i64,
    pub plugin_id: String,
    pub version: String,
    pub prerelease: bool,
    pub bundle_id: String,
    pub repository: String,
    pub tag: String,
    pub source_commit: String,
    pub target: String,
    pub archive_name: String,
    pub archive_sha256: String,
    pub archive_size: u64,
    pub metadata_sha256: String,
    pub release_notes: String,
    pub account: String,
    pub plan_sha256: String,
    pub release_url: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PublishedProviderRelease {
    pub release_url: String,
    pub repository: String,
    pub tag: String,
    pub source_commit: String,
    pub archive_sha256: String,
    pub already_published: bool,
}

use plan::{plan_sha, Plan};

struct PreparedContext {
    local: local::LocalRelease,
    inspection: remote::GitHubReleaseInspection,
    token: String,
    _permit: tokio::sync::SemaphorePermit<'static>,
}

impl PreparedContext {
    fn request<'a>(&'a self, binding_sha256: &'a str) -> GitHubPublishRequest<'a> {
        GitHubPublishRequest::builder()
            .repository(&self.local.plan.repository)
            .tag(&self.local.plan.tag)
            .source_commit(&self.local.plan.source_commit)
            .release_notes(&self.local.plan.release_notes)
            .prerelease(self.local.plan.prerelease)
            .archive_name(&self.local.plan.archive_name)
            .archive(&self.local.archive)
            .archive_sha256(&self.local.plan.archive_sha256)
            .metadata_name("package.json")
            .metadata(&self.local.metadata)
            .metadata_sha256(&self.local.plan.metadata_sha256)
            .expected_repository_id(self.inspection.repository_id)
            .expected_account(&self.inspection.account)
            .binding_sha256(binding_sha256)
            .build()
    }
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/publication-release/preview",
    params(("id" = i64, Path,)),
    request_body = PreviewPublicationReleaseRequest,
    responses((status = 200, body = PublicationReleasePreview), (status = 400), (status = 404), (status = 409))
)]
pub async fn preview_publication_release_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<PreviewPublicationReleaseRequest>, JsonRejection>,
) -> Result<Json<PublicationReleasePreview>, AppError> {
    let Json(body) = payload.map_err(json_rejection)?;
    validate_notes(&body.release_notes)?;
    let permit = permit()?;
    let prepared = operation_timeout(prepare_context(
        &state,
        project_id,
        body.bundle_id,
        body.release_notes,
        permit,
    ))
    .await?;
    let local = prepared.local;
    let inspection = prepared.inspection;
    let plan_sha256 = plan_sha(&local.plan, &inspection.account, inspection.repository_id)?;
    let release_url = release_url(&local.plan.repository, &local.plan.tag);
    Ok(Json(PublicationReleasePreview {
        project_id: local.plan.project_id,
        plugin_id: local.plan.plugin_id,
        version: local.plan.version,
        prerelease: local.plan.prerelease,
        bundle_id: local.plan.bundle_id,
        repository: local.plan.repository,
        tag: local.plan.tag,
        source_commit: local.plan.source_commit,
        target: local.plan.target,
        archive_name: local.plan.archive_name,
        archive_sha256: local.plan.archive_sha256,
        archive_size: local.plan.archive_size,
        metadata_sha256: local.plan.metadata_sha256,
        release_notes: local.plan.release_notes,
        account: inspection.account,
        plan_sha256,
        release_url,
    }))
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/publication-release",
    params(("id" = i64, Path,)),
    request_body = PublishPublicationReleaseRequest,
    responses((status = 200, body = PublishedProviderRelease), (status = 400), (status = 404), (status = 409))
)]
pub async fn publish_publication_release_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<PublishPublicationReleaseRequest>, JsonRejection>,
) -> Result<Json<PublishedProviderRelease>, AppError> {
    let Json(body) = payload.map_err(json_rejection)?;
    if !body.confirmed {
        return Err(coded(
            "PUBLICATION_RELEASE_CONFIRMATION_REQUIRED",
            "publication release must be explicitly confirmed",
        ));
    }
    validate_notes(&body.release_notes)?;
    let permit = permit()?;
    operation_timeout(publish_prepared(&state, project_id, body, permit)).await
}

async fn publish_prepared(
    state: &AppState,
    project_id: i64,
    body: PublishPublicationReleaseRequest,
    permit: tokio::sync::SemaphorePermit<'static>,
) -> Result<Json<PublishedProviderRelease>, AppError> {
    let prepared = prepare_context(
        state,
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
            "PUBLICATION_RELEASE_PLAN_CHANGED",
            "publication release plan changed; preview it again",
        ));
    }
    let published =
        github::publish_publication_release(&prepared.token, prepared.request(&actual)).await?;
    let local = prepared.local;
    Ok(Json(PublishedProviderRelease {
        release_url: published.release_url,
        repository: local.plan.repository,
        tag: local.plan.tag,
        source_commit: local.plan.source_commit,
        archive_sha256: local.plan.archive_sha256,
        already_published: published.already_published,
    }))
}

async fn prepare_context(
    state: &AppState,
    project_id: i64,
    bundle_id: String,
    release_notes: String,
    permit: tokio::sync::SemaphorePermit<'static>,
) -> Result<PreparedContext, AppError> {
    let (root, plugin_id) =
        super::publication_readiness::provider_project(&state.read_pool, project_id).await?;
    let output_root =
        crate::domain::settings_store::dir::sibling_dir("provider-publication-bundles");
    let (local, _permit) = tokio::task::spawn_blocking(move || {
        (
            local::load(
                project_id,
                plugin_id,
                output_root,
                &bundle_id,
                release_notes,
            ),
            permit,
        )
    })
    .await
    .map_err(|error| {
        AppError::Internal(format!("publication release inspection failed: {error}"))
    })?;
    let local = local?;
    let source_commit = local::git::inspect_git(&root, &local.plan.repository).await?;
    let mut local = local;
    local.plan.source_commit = source_commit;
    let config = host_configs()?.remove("github.com");
    let credentials = resolve_credentials(
        &state.forge_auth,
        "github.com",
        GitHost::GitHub,
        config.as_ref(),
    )
    .await
    .map_err(forge_to_app_error)?
    .ok_or_else(|| {
        coded(
            "PUBLICATION_RELEASE_AUTH_REQUIRED",
            "GitHub authentication is required",
        )
    })?;
    let inspection = github::inspect_publication_release(
        &credentials.token,
        &local.plan.repository,
        &local.plan.tag,
    )
    .await?;
    if inspection.tag_commit != local.plan.source_commit {
        return Err(coded(
            "PUBLICATION_RELEASE_TAG_MISMATCH",
            "the remote release tag must already exist and target Git HEAD",
        ));
    }
    Ok(PreparedContext {
        local,
        inspection,
        token: credentials.token,
        _permit,
    })
}

async fn operation_timeout<F, T>(future: F) -> Result<T, AppError>
where
    F: std::future::Future<Output = Result<T, AppError>>,
{
    tokio::time::timeout(OPERATION_TIMEOUT, future)
        .await
        .map_err(|_| {
            coded_status(
                StatusCode::GATEWAY_TIMEOUT,
                "PUBLICATION_RELEASE_TIMEOUT",
                "publication timed out; review any remote draft before retrying",
            )
        })?
}

fn release_url(repository: &str, tag: &str) -> String {
    format!("https://github.com/{repository}/releases/tag/{tag}")
}

fn validate_notes(notes: &str) -> Result<(), AppError> {
    if notes.len() > MAX_RELEASE_NOTES_BYTES {
        return Err(coded(
            "PUBLICATION_RELEASE_INVALID",
            "release notes exceed 16 KiB",
        ));
    }
    Ok(())
}

fn permit() -> Result<tokio::sync::SemaphorePermit<'static>, AppError> {
    RELEASE_OPERATION.try_acquire().map_err(|_| {
        coded_status(
            StatusCode::CONFLICT,
            "PUBLICATION_RELEASE_BUSY",
            "another publication release operation is running",
        )
    })
}

fn json_rejection(rejection: JsonRejection) -> AppError {
    coded("PUBLICATION_RELEASE_REQUEST_INVALID", rejection.body_text())
}

fn coded(code: &'static str, message: impl Into<String>) -> AppError {
    coded_status(StatusCode::BAD_REQUEST, code, message)
}

fn coded_status(status: StatusCode, code: &'static str, message: impl Into<String>) -> AppError {
    AppError::coded(status, code, message)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{id}/publication-release/preview",
            post(preview_publication_release_handler),
        )
        .route(
            "/api/projects/{id}/publication-release",
            post(publish_publication_release_handler),
        )
        .merge(contribution::router())
        .merge(registry::router())
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}
