//! Dynamic installed metadata; the marketplace is the authority for new servers.
pub use super::legacy::ServerRole;
use super::probe::ServerProbe;
use crate::error::AppError;
pub(super) const SELECTION_REQUIRED: &str =
    "Several language servers support this file; select one in Editor settings";

pub async fn lookup(language: &str) -> Result<Option<ServerProbe>, AppError> {
    let mut candidates = super::managed::inventory()
        .await?
        .into_iter()
        .filter(|entry| {
            entry.language_ids.iter().any(|id| id == language)
                && matches!(entry.role, ServerRole::TypeChecker | ServerRole::General)
                && entry.error.is_none()
        });
    let first = candidates.next();
    if candidates.next().is_some() {
        return Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "LSP_SELECTION_REQUIRED",
            SELECTION_REQUIRED,
        ));
    }
    Ok(first)
}

pub async fn lookup_by_id(id: &str) -> Result<Option<ServerProbe>, AppError> {
    Ok(super::managed::inventory()
        .await?
        .into_iter()
        .find(|entry| entry.lsp_id == id))
}
