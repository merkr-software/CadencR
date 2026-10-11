mod archive;
mod input;
mod output;
mod quota;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, Json, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::app_state::AppState;
use crate::error::AppError;

const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const BUSY: &str = "PUBLICATION_PACKAGE_BUSY";
static PACKAGE_BUILD: Semaphore = Semaphore::const_new(1);

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreparePublicationPackageRequest {
    pub metadata_json: String,
    pub staging_directory: String,
    pub target: String,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct PreparedPublicationPackage {
    pub project_id: i64,
    pub plugin_id: String,
    pub target: String,
    pub archive_path: String,
    pub metadata_path: String,
    pub sha256: String,
    pub size: u64,
}

#[utoipa::path(
    post,
    path = "/api/projects/{id}/publication-package",
    params(("id" = i64, Path,)),
    request_body = PreparePublicationPackageRequest,
    responses(
        (status = 200, body = PreparedPublicationPackage),
        (status = 400, description = "Invalid project, metadata, target, or staging directory"),
        (status = 404, description = "Project does not exist"),
        (status = 409, description = "Another package is being prepared")
    )
)]
pub async fn prepare_publication_package_handler(
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    payload: Result<Json<PreparePublicationPackageRequest>, JsonRejection>,
) -> Result<Json<PreparedPublicationPackage>, AppError> {
    let Json(body) = payload.map_err(json_rejection)?;
    let (project_root, plugin_id) =
        super::publication_readiness::provider_project(&state.read_pool, project_id).await?;
    let output_root =
        crate::domain::settings_store::dir::sibling_dir("provider-publication-bundles");
    let permit = PACKAGE_BUILD.try_acquire().map_err(|_| {
        AppError::coded(
            StatusCode::CONFLICT,
            BUSY,
            "another publication package is being prepared",
        )
    })?;
    // Deliberately not cancellation-coupled to the HTTP connection: once admitted, the
    // bounded local build finishes durably even if the client disconnects. The retained
    // bundle quota prevents abandoned successful outputs from growing without bound.
    let response = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let prepared = input::prepare(project_id, project_root, plugin_id, output_root, body)?;
        output::build_package(prepared)
    })
    .await
    .map_err(|error| AppError::Internal(format!("publication package task failed: {error}")))??;
    Ok(Json(response))
}

fn json_rejection(rejection: JsonRejection) -> AppError {
    AppError::coded(
        StatusCode::BAD_REQUEST,
        "PUBLICATION_PACKAGE_REQUEST_INVALID",
        rejection.body_text(),
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{id}/publication-package",
            post(prepare_publication_package_handler),
        )
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
}
