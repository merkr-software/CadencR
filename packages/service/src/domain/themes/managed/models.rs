use crate::domain::marketplace::models::SignedMixedCatalog;
use crate::domain::themes::models::UserTheme;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

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
    /// Referenced by any saved manual/light/dark selection, not necessarily displayed.
    /// The frontend owns OS appearance and resolves the effective displayed theme.
    pub active: bool,
    pub theme: Option<UserTheme>,
    /// Offline policy fallback diagnostic; the authenticated theme remains usable.
    pub warning: Option<String>,
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

#[derive(Debug, Serialize, ToSchema)]
pub struct ManagedThemeDuplicateResponse {
    #[serde(flatten)]
    pub created: crate::domain::themes::models::CreateThemeResponse,
    /// Offline policy fallback diagnostic for a successfully created author copy.
    pub warning: Option<String>,
}
