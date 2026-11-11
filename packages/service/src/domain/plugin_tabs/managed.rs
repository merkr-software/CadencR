//! Signed tab revisions live separately from editable author folders.
pub mod policy;
pub mod routes;
pub mod service;
pub mod storage;

use crate::error::AppError;
use axum::http::StatusCode;
use cadencr_plugin_core::tab::TabPlatform;
use cadencr_registry_core::{SignedTabBackend, SignedTabBinary, TabBackendRefusal};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallManagedTabRequest {
    pub tab_id: String,
    pub version: String,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedTabInventoryEntry {
    pub id: String,
    pub name: String,
    /// The active revision's version.
    pub version: String,
    pub error: Option<String>,
    /// A verified update staged beside the active revision, waiting for the
    /// user to accept what it may now run (`PUT /api/plugin-tabs/{id}/consent`
    /// with its permissions hash) or to discard it.
    pub pending_version: Option<String>,
    /// The platform whose native backend binary the active revision holds
    /// (`darwin-aarch64`, …); `None` for a tab without a backend.
    pub platform: Option<TabPlatform>,
    /// Why Cadencr's signed revocation policy blocks the active revision: it
    /// cannot run, only be removed (or updated to a version not blocked).
    pub blocked: Option<String>,
}

impl ManagedTabInventoryEntry {
    /// The entry of an installed revision, with nothing staged beside it.
    pub fn from_revision(
        id: String,
        revision: storage::VerifiedRevision,
        blocked: Option<String>,
    ) -> Self {
        Self {
            id,
            name: revision.manifest.name,
            version: revision.manifest.version,
            error: None,
            pending_version: None,
            platform: revision.facts.backend.map(|backend| backend.platform),
            blocked,
        }
    }
}

/// 409 `MANAGED_TAB_PLATFORM_UNSUPPORTED`: the tab's backend ships no binary
/// for the platform Cadencr runs on, so it is not installed here.
pub fn platform_unsupported(id: &str, backend: &SignedTabBackend) -> AppError {
    let platforms: Vec<&str> = backend.targets.keys().map(|p| p.as_str()).collect();
    AppError::coded(
        StatusCode::CONFLICT,
        "MANAGED_TAB_PLATFORM_UNSUPPORTED",
        format!(
            "custom tab `{id}` is not available on this platform{}: its native backend ships for {}",
            TabPlatform::current()
                .map(|platform| format!(" ({platform})"))
                .unwrap_or_default(),
            platforms.join(", ")
        ),
    )
}

/// This host's binary of `backend`: 409 `MANAGED_TAB_PLATFORM_UNSUPPORTED`
/// when it ships none for the platform Cadencr runs on.
pub fn require_host_target<'a>(
    id: &str,
    backend: &'a SignedTabBackend,
) -> Result<(TabPlatform, &'a SignedTabBinary), AppError> {
    backend
        .host_target()
        .ok_or_else(|| platform_unsupported(id, backend))
}

/// The signed package's backend, if it declares one. A backend this Cadencr
/// cannot run yet (an unknown protocol or platform) is 409
/// `MANAGED_TAB_NEEDS_NEWER_APP`, any other refusal 400 `MANAGED_TAB_INVALID`.
pub fn signed_backend(
    id: &str,
    package: &serde_json::Value,
) -> Result<Option<SignedTabBackend>, AppError> {
    cadencr_registry_core::signed_tab_backend(package).map_err(|refusal| match refusal {
        TabBackendRefusal::UnsupportedProtocol { protocol } => {
            needs_newer_app(id, &format!("its backend speaks protocol {protocol}"))
        }
        TabBackendRefusal::UnknownPlatform { key } => needs_newer_app(
            id,
            &format!("its backend ships for `{key}`, a platform this Cadencr does not know"),
        ),
        TabBackendRefusal::Invalid(error) => invalid(error),
    })
}

/// 409 `MANAGED_TAB_NEEDS_NEWER_APP`: the signed package's backend speaks a
/// protocol, or ships for a platform, this Cadencr does not know (`detail`
/// says which); a newer Cadencr may install it.
fn needs_newer_app(id: &str, detail: &str) -> AppError {
    AppError::coded(
        StatusCode::CONFLICT,
        "MANAGED_TAB_NEEDS_NEWER_APP",
        format!("custom tab `{id}` needs a newer Cadencr: {detail}"),
    )
}

pub fn invalid(message: impl std::fmt::Display) -> AppError {
    AppError::coded(
        StatusCode::BAD_REQUEST,
        "MANAGED_TAB_INVALID",
        message.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::marketplace::catalog;
    use crate::domain::plugin_tabs::test_support::error_code;

    #[test]
    fn a_backend_this_cadencr_does_not_know_needs_a_newer_app() {
        let temp = tempfile::tempdir().unwrap();
        let tab = storage::fixtures::backend_fixture()
            .root(temp.path())
            .call();
        let package = catalog::resolve_kind(&tab.receipt.index, "graph", "1.0.0", "tab").unwrap();
        assert!(signed_backend("graph", &package).unwrap().is_some());
        let mut future = package.clone();
        future["tab"]["backend"]["protocol"] = serde_json::json!(2);
        let refused = signed_backend("graph", &future).unwrap_err();
        assert_eq!(error_code(&refused), "MANAGED_TAB_NEEDS_NEWER_APP");
        assert!(refused.to_string().contains("protocol 2"), "{refused}");
        let mut elsewhere = package.clone();
        let binary = &mut elsewhere["tab"]["distribution"]["binary"];
        let entry = binary.as_object().unwrap().values().next().unwrap().clone();
        binary["windows-x86_64"] = entry;
        let refused = signed_backend("graph", &elsewhere).unwrap_err();
        assert!(refused.to_string().contains("windows-x86_64"), "{refused}");
        assert_eq!(error_code(&refused), "MANAGED_TAB_NEEDS_NEWER_APP");
        // Anything else wrong stays an invalid package.
        let mut broken = package;
        broken["tab"]["distribution"]["binary"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .for_each(|entry| {
                entry.as_object_mut().unwrap().remove("executable_sha256");
            });
        let refused = signed_backend("graph", &broken).unwrap_err();
        assert_eq!(error_code(&refused), "MANAGED_TAB_INVALID");
    }
}
