use crate::domain::agents::providers::installed::managed::ManagedIndexSignature;
use crate::domain::themes::models::UserTheme;
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
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallManagedThemeRequest {
    pub index: SignedMixedCatalog,
    pub theme_id: String,
    pub version: String,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedThemeInventoryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub active: bool,
    pub theme: Option<UserTheme>,
    pub error: Option<String>,
    pub error_code: Option<String>,
}
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RemoveManagedThemeRequest {
    #[serde(default)]
    pub confirm_builtin_fallback: bool,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct RemoveManagedThemeResponse {
    pub success: bool,
    pub fallback: Option<String>,
}
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DuplicateManagedThemeRequest {
    pub label: String,
}
#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedThemeCatalogResponse {
    pub index: Option<SignedMixedCatalog>,
    pub recommended_versions: std::collections::BTreeMap<String, String>,
    pub verified: bool,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub index: SignedMixedCatalog,
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub files: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pointer {
    pub version: String,
    pub sha256: String,
}
