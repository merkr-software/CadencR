//! `GET /api/editor/read-document` — streams raw PDF / Office / CSV bytes for the
//! desktop document preview (Preview tab and the editor's document viewer).
//! Same shape as `read-image`: an explicit extension allowlist, a size cap,
//! and raw bytes outside the OpenAPI surface like the other byte routes.
//!
//! Workbooks saved without their formula results get them computed first
//! (`workbook_recalc`); the `X-Cadencr-Formulas` header tells the viewer so.

use axum::extract::{Query, State};
use axum::http::HeaderValue;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

use super::routes::ReadFileParams;
use super::service;
use super::workbook_recalc::{recalculate_workbook, FormulaSummary};
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;
use crate::shared::capped_read::read_file_capped;
use crate::shared::document_file::{document_mime_for_path, MAX_DOCUMENT_FILE_SIZE, XLSX_MIME};
use crate::shared::image_file::image_response;

pub async fn read_document_handler(
    State(state): State<AppState>,
    Query(params): Query<ReadFileParams>,
) -> Result<Response, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let path = service::validate_path(&project_root, &params.file_path)?;

    let mime = document_mime_for_path(&path)
        .ok_or_else(|| AppError::BadRequest("Unsupported document extension".into()))?;

    let bytes = read_file_capped(path, MAX_DOCUMENT_FILE_SIZE, "Document").await?;
    let (bytes, formulas) = if mime == XLSX_MIME {
        with_formula_results(bytes).await?
    } else {
        (bytes, None)
    };
    // Same raw-bytes response the image routes use: content type, length,
    // and a no-cache header so an agent rewriting the file is picked up.
    let mut response = image_response(bytes, mime)?;
    if let Some(formulas) = formulas {
        response.headers_mut().insert(FORMULAS_HEADER, formulas);
    }
    Ok(response)
}

/// Response header describing a recalculation, form-encoded:
/// `computed=12&unresolved=1`, or `error=<reason>` when the workbook needed
/// one and couldn't get it (its bytes are then served as saved). Absent when
/// the workbook already carried its results.
pub const FORMULAS_HEADER: &str = "x-cadencr-formulas";

async fn with_formula_results(bytes: Vec<u8>) -> Result<(Vec<u8>, Option<HeaderValue>), AppError> {
    let (bytes, summary) = tokio::task::spawn_blocking(move || recalculate_workbook(bytes))
        .await
        .map_err(|e| AppError::internal(format!("Workbook recalculation task failed: {e}")))?;
    let header = summary
        .map(|summary| HeaderValue::try_from(formulas_header(summary)))
        .transpose()
        .map_err(|e| AppError::internal(format!("Invalid formulas header: {e}")))?;
    Ok((bytes, header))
}

fn formulas_header(summary: FormulaSummary) -> String {
    match summary {
        FormulaSummary::Computed {
            computed,
            unresolved,
        } => format!("computed={computed}&unresolved={unresolved}"),
        FormulaSummary::Failed { reason } => {
            tracing::warn!(%reason, "workbook formulas not recalculated");
            format!("error={}", utf8_percent_encode(&reason, NON_ALPHANUMERIC))
        }
    }
}

pub fn document_router() -> Router<AppState> {
    Router::new().route("/api/editor/read-document", get(read_document_handler))
}
