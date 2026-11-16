//! The registry trust every marketplace kind verifies with, as the UI sees
//! it: whether it is usable, and when it is not, why and the way out.
use crate::domain::agents::providers::installed::managed::trust::{
    pinned_index_trust_status, set_aside_registry_trust_generation, PinnedIndexTrustStatus,
    TrustRecovery,
};
use crate::{app_state::AppState, error::AppError};
use axum::{
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceTrustState {
    /// This build verifies the marketplace with its pinned trust.
    Configured,
    /// This build pins no trust: the marketplace is unavailable in it.
    Unconfigured,
    /// This build pins trust that cannot be used: nothing verifies.
    Invalid,
}

/// The way out of an invalid trust configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarketplaceTrustRecovery {
    /// Install an official Cadencr build; this one's compiled trust is broken.
    Reinstall,
    /// Update Cadencr; the data directory trusts a newer generation.
    UpdateApp,
    /// Set the unreadable `file` aside (renamed beside it, kept) and rebuild.
    SetAside,
    /// Fix what `error` names by hand, then restart Cadencr.
    Repair,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MarketplaceTrustStatus {
    pub status: MarketplaceTrustState,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub recovery: Option<MarketplaceTrustRecovery>,
    /// The file a `set_aside` recovery renames.
    pub file: Option<String>,
    /// Where a set-aside file was kept, in the answer to that action.
    pub kept_at: Option<String>,
}

impl From<PinnedIndexTrustStatus> for MarketplaceTrustStatus {
    fn from(status: PinnedIndexTrustStatus) -> Self {
        let (state, error_code, error, recovery, file) = match status {
            PinnedIndexTrustStatus::Unconfigured => {
                (MarketplaceTrustState::Unconfigured, None, None, None, None)
            }
            PinnedIndexTrustStatus::Configured { .. }
            | PinnedIndexTrustStatus::Generation { .. } => {
                (MarketplaceTrustState::Configured, None, None, None, None)
            }
            PinnedIndexTrustStatus::Invalid {
                code,
                message,
                recovery,
            } => {
                let (recovery, file) = match recovery {
                    TrustRecovery::Reinstall => (MarketplaceTrustRecovery::Reinstall, None),
                    TrustRecovery::UpdateApp => (MarketplaceTrustRecovery::UpdateApp, None),
                    TrustRecovery::Repair => (MarketplaceTrustRecovery::Repair, None),
                    TrustRecovery::SetAside { path } => (
                        MarketplaceTrustRecovery::SetAside,
                        Some(path.display().to_string()),
                    ),
                };
                (
                    MarketplaceTrustState::Invalid,
                    Some(code.to_string()),
                    Some(message),
                    Some(recovery),
                    file,
                )
            }
        };
        Self {
            status: state,
            error_code,
            error,
            recovery,
            file,
            kept_at: None,
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/marketplace/trust", get(get_marketplace_trust))
        .route(
            "/api/marketplace/trust/set-aside",
            post(set_aside_marketplace_trust),
        )
}

#[utoipa::path(get, path = "/api/marketplace/trust", operation_id = "getMarketplaceTrust", responses((status = 200, body = MarketplaceTrustStatus)))]
pub async fn get_marketplace_trust() -> Json<MarketplaceTrustStatus> {
    Json(pinned_index_trust_status().into())
}

#[utoipa::path(post, path = "/api/marketplace/trust/set-aside", operation_id = "setAsideMarketplaceTrust", responses((status = 200, body = MarketplaceTrustStatus)))]
pub async fn set_aside_marketplace_trust() -> Result<Json<MarketplaceTrustStatus>, AppError> {
    let outcome = set_aside_registry_trust_generation().await?;
    let mut status = MarketplaceTrustStatus::from(outcome.status);
    status.kept_at = Some(outcome.kept_at.display().to_string());
    Ok(Json(status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unreadable_generation_offers_setting_its_file_aside() {
        let status = MarketplaceTrustStatus::from(PinnedIndexTrustStatus::Invalid {
            code: "PINNED_TRUST_CONFIGURATION_INVALID",
            message: "generation.json: expected value".into(),
            recovery: TrustRecovery::SetAside {
                path: "/data/registry-trust/generation.json".into(),
            },
        });
        assert_eq!(status.status, MarketplaceTrustState::Invalid);
        assert_eq!(status.recovery, Some(MarketplaceTrustRecovery::SetAside));
        assert_eq!(
            status.file.as_deref(),
            Some("/data/registry-trust/generation.json")
        );
        assert_eq!(
            status.error_code.as_deref(),
            Some("PINNED_TRUST_CONFIGURATION_INVALID")
        );
    }
}
