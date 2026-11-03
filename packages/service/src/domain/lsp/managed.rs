//! Explicit signed marketplace lifecycle. Opening a file only reads installed state.
use super::probe::ServerProbe;
use crate::domain::themes::managed::{catalog, models::SignedMixedCatalog};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use utoipa::ToSchema;

mod availability;
pub use availability::LspVersionUnavailable;
mod install;
mod legacy;
pub mod policy;
pub mod storage;
pub use install::{install, remove};

#[derive(Debug, Serialize, ToSchema)]
pub struct LspCatalogResponse {
    pub index: Option<SignedMixedCatalog>,
    pub verified: bool,
    pub recommended_versions: BTreeMap<String, String>,
    pub error: Option<String>,
    pub host_platform: String,
    pub blocked_versions: BTreeMap<String, BTreeMap<String, String>>,
    pub unavailable_versions: BTreeMap<String, BTreeMap<String, LspVersionUnavailable>>,
}
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallLspRequest {
    pub lsp_id: String,
    pub version: String,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoveLspRequest {
    pub lsp_id: String,
}

pub fn invalid(error: impl std::fmt::Display) -> AppError {
    AppError::coded(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "LSP_PACKAGE_INVALID",
        error.to_string(),
    )
}
pub fn platform() -> &'static str {
    crate::domain::agents::providers::installed::descriptor::current_binary_target()
        .unwrap_or("unsupported")
}
pub async fn catalog(refresh: bool) -> LspCatalogResponse {
    if refresh {
        legacy::invalidate().await;
    }
    let (response, policy_result) =
        tokio::join!(catalog::acquire_catalog(refresh), policy::refresh(refresh));
    let policy_error = policy_result.err().map(|error| error.to_string());
    let mut error = response
        .error
        .into_iter()
        .chain(policy_error)
        .collect::<Vec<_>>();
    let availability = if let Some(index) = &response.index {
        match availability::acquire(index.clone()).await {
            Ok(availability) => availability,
            Err(failure) => {
                error.push(failure.to_string());
                availability::Availability::default()
            }
        }
    } else {
        availability::Availability::default()
    };
    LspCatalogResponse {
        index: response.index,
        verified: response.verified,
        recommended_versions: availability.recommended,
        host_platform: platform().to_string(),
        blocked_versions: availability.blocked,
        unavailable_versions: availability.unavailable,
        error: (!error.is_empty()).then(|| error.join("; ")),
    }
}
/// Recommendations use the same platform, revocation, compatibility and runtime gates as install.
pub async fn recommendations(
    index: SignedMixedCatalog,
) -> Result<BTreeMap<String, String>, AppError> {
    Ok(availability::acquire(index).await?.recommended)
}

pub async fn inventory() -> Result<Vec<ServerProbe>, AppError> {
    let root = storage::root()?;
    let mut entries = tokio::task::spawn_blocking(move || storage::inventory(&root))
        .await
        .map_err(invalid)??;
    // Only the bounded pre-marketplace migration map is ever searched on PATH.
    let legacy = legacy::inventory().await?;
    let additional = legacy
        .into_iter()
        .filter(|entry| {
            !entries
                .iter()
                .any(|existing| existing.lsp_id == entry.lsp_id)
        })
        .collect::<Vec<_>>();
    entries.extend(additional);
    entries.sort_by(|a, b| a.lsp_id.cmp(&b.lsp_id));
    Ok(entries)
}
