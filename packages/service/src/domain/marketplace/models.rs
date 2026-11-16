//! The signed mixed catalog every managed extension kind installs from, and
//! the catalog response the marketplace routes share.
use crate::domain::agents::providers::installed::managed::ManagedIndexSignature;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignedMixedCatalog {
    pub signed: MixedCatalogPayload,
    pub signature: ManagedIndexSignature,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MixedCatalogPayload {
    pub schema_version: u32,
    pub generated_at: String,
    pub expires_at: String,
    pub packages: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schema(value_type = Vec<Value>)]
    pub provider_handoffs: Vec<cadencr_registry_core::ProviderHandoff>,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedThemeCatalogResponse {
    pub index: Option<SignedMixedCatalog>,
    pub recommended_versions: std::collections::BTreeMap<String, String>,
    pub verified: bool,
    pub error: Option<String>,
    /// The custom-tab catalog only: the platform a tab's native backend must
    /// ship for to install here (`darwin-aarch64`, …), `None` where Cadencr
    /// runs no tab backends. Versions without it are never recommended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_platform: Option<cadencr_plugin_core::tab::TabPlatform>,
    /// The custom-tab catalog only: the versions Cadencr's revocation policy
    /// blocks here, by tab id then version, with the policy's reason. They
    /// are never recommended, and installing one is refused.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub blocked_versions:
        std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    /// The custom-tab catalog: the versions that cannot install here, by
    /// tab id then version, and why. They are never recommended.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub unavailable_versions: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<String, TabVersionUnavailable>,
    >,
}
/// Why a catalog tab or provider version does not install on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TabVersionUnavailable {
    /// It ships no binary for the platform Cadencr runs on (a tab's native
    /// backend, or a provider's agent), or Cadencr has no name for that
    /// platform.
    Platform,
    /// It needs a newer Cadencr: its backend speaks a protocol, or ships for
    /// a platform, this build does not know.
    Protocol,
}
