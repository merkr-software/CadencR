//! The theme view of the shared marketplace catalog.
use crate::domain::marketplace::models::ManagedThemeCatalogResponse;
use crate::domain::marketplace::{catalog, models::SignedMixedCatalog};
use crate::error::AppError;
use serde_json::Value;

/// The catalog with the theme revocation policy refreshed alongside it and
/// the recommended version of each theme.
pub async fn acquire(refresh: bool) -> ManagedThemeCatalogResponse {
    let policy = async {
        match super::policy::refresh(refresh).await {
            Ok(warning) => warning,
            Err(error) => Some(error.to_string()),
        }
    };
    let mut response = catalog::acquire_with_policy(refresh, policy).await;
    if let Some(index) = &response.index {
        response.recommended_versions = catalog::recommended_for(index, "theme", |_| true);
    }
    response
}
pub fn resolve(index: &SignedMixedCatalog, id: &str, version: &str) -> Result<Value, AppError> {
    catalog::resolve_kind(index, id, version, "theme")
}
