//! `GET /api/editor/read-image` — streams raw image bytes for the
//! in-editor `ImageFileViewer`. Distinct from `read_file_handler`
//! because that endpoint rejects binary files; this one is gated by an
//! explicit image-extension allowlist and a larger (25 MB) size limit.
//!
//! Extracted into its own module so `routes.rs` stays manageable.

use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;

use super::routes::ReadFileParams;
use super::service;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;
use crate::shared::capped_read::read_file_capped;
use crate::shared::image_file::{image_mime_for_path, image_response, MAX_IMAGE_FILE_SIZE};

#[utoipa::path(
    get,
    path = "/api/editor/read-image",
    params(ReadFileParams),
    responses(
        (status = 200, description = "Raw image bytes", content_type = "image/*"),
        (status = 400, description = "Unsupported extension or file too large"),
        (status = 404, description = "File not found"),
    )
)]
pub async fn read_image_handler(
    State(state): State<AppState>,
    Query(params): Query<ReadFileParams>,
) -> Result<Response, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let path = service::validate_path(&project_root, &params.file_path)?;

    let mime = image_mime_for_path(&path)
        .ok_or_else(|| AppError::BadRequest("Unsupported image extension".into()))?;

    let bytes = read_file_capped(path, MAX_IMAGE_FILE_SIZE, "Image").await?;
    image_response(bytes, mime)
}

pub fn image_router() -> Router<AppState> {
    Router::new().route("/api/editor/read-image", get(read_image_handler))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_limit_is_25_mb() {
        assert_eq!(MAX_IMAGE_FILE_SIZE, 25 * 1024 * 1024);
    }
}
