use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The stable identity and human label for a new provider connector project.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateProviderWorkspaceRequest {
    /// ACP Registry-compatible provider id, e.g. `pi-connector`.
    pub provider_id: String,
    /// Human-readable name used in the project and scaffold.
    pub display_name: String,
}

/// The ordinary Cadencr project and conversation created for provider work.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ProviderWorkspace {
    pub project_id: i64,
    pub feature_id: i64,
}
