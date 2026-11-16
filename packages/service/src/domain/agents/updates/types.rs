//! Public, provider-neutral update status shapes (HTTP + WebSocket).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::agents::runtime::ProviderOrigin;

/// Result of the latest version check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderUpdateState {
    /// No check has completed since the service started.
    Unchecked,
    UpToDate,
    UpdateAvailable,
    /// The provider's CLI is not installed on this machine.
    NotInstalled,
    /// The provider does not manage its own updates.
    Unsupported,
    CheckFailed,
}

/// Work currently running for a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderUpdateActivity {
    Checking,
    Updating,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProviderUpdateStatus {
    pub provider_id: String,
    pub label: String,
    pub origin: ProviderOrigin,
    pub state: ProviderUpdateState,
    pub activity: Option<ProviderUpdateActivity>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    /// Installable versions, newest first.
    pub available_versions: Vec<String>,
    /// Whether an explicit version may be requested instead of the latest.
    pub supports_target_version: bool,
    /// Why the last check failed, when `state` is `check_failed`.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProviderUpdatesResponse {
    /// Every registered provider, in catalog order.
    pub providers: Vec<ProviderUpdateStatus>,
    /// RFC 3339 timestamp of the last completed full check.
    pub checked_at: Option<String>,
}

impl ProviderUpdatesResponse {
    pub fn into_event(self, outcome: Option<ProviderUpdateOutcome>) -> ProviderUpdateEvent {
        ProviderUpdateEvent {
            providers: self.providers,
            checked_at: self.checked_at,
            outcome,
        }
    }
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ProviderUpdateRequest {
    /// Version to install. Omit for the latest version.
    pub version: Option<String>,
}

/// How a finished update ended. Carried once, on the event that closes it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProviderUpdateOutcome {
    pub provider_id: String,
    pub label: String,
    pub success: bool,
    pub previous_version: Option<String>,
    pub current_version: Option<String>,
    /// Failure reason, or the provider's own summary on success.
    pub message: Option<String>,
}

/// `app/provider_updates` WebSocket payload: the full status list plus, when
/// an update just finished, its outcome.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProviderUpdateEvent {
    pub providers: Vec<ProviderUpdateStatus>,
    pub checked_at: Option<String>,
    pub outcome: Option<ProviderUpdateOutcome>,
}
