//! Serialized schema-2 package contract shared by publisher, service and tooling.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "package",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum MarketplacePackage {
    Provider(ProviderPackage),
    Theme(ThemePackage),
    Tab(TabPackage),
    Lsp(crate::LspPackage),
    Plugin(PluginPackage),
}
/// A multi-export plugin: complete single-kind members released together
/// (see [`crate::plugin_package`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginPackage {
    pub plugin: PluginDescriptor,
    pub host: MarketplaceHost,
    pub contributes: Vec<MarketplacePackage>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repository: String,
    pub license: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderPackage {
    /// ACP protocol metadata, retaining validated protocol extension fields.
    pub agent: Value,
    pub host: MarketplaceHost,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemePackage {
    pub theme: ThemeDescriptor,
    pub host: MarketplaceHost,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabPackage {
    pub tab: TabDescriptor,
    pub host: MarketplaceHost,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repository: String,
    pub license: String,
    pub api_version: u64,
    /// The native backend the tab ships (`tab.json` `backend`), present
    /// exactly when `distribution.binary` is: shown before download.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<TabBackendDescriptor>,
    pub distribution: TabDistribution,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabBackendDescriptor {
    pub protocol: u32,
    pub reasoning: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabDistribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// The platform-neutral web archive (`tab.json`, icon, compiled web root).
    pub archive: String,
    pub sha256: String,
    /// One native backend archive per platform. Strict: parsed only after
    /// the publish rules accepted every key (a consumed catalog may carry
    /// unknown ones — see [`crate::signed_tab_backend`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary:
        Option<std::collections::BTreeMap<cadencr_plugin_core::tab::TabPlatform, TabBinaryTarget>>,
}
/// One platform's backend archive: a single executable at `cmd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TabBinaryTarget {
    pub archive: String,
    /// SHA-256 of the archive bytes.
    pub sha256: String,
    /// Archive length in bytes.
    pub size: u64,
    /// The executable's path inside the installed tab folder (`tab.json`
    /// `backend.binary.<platform>`).
    pub cmd: String,
    /// SHA-256 of the executable, re-checked before every launch.
    pub executable_sha256: String,
    pub executable_size: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repository: String,
    pub license: String,
    pub document_version: u64,
    pub distribution: ThemeDistribution,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeDistribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub archive: String,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketplaceHost {
    pub publisher: String,
    pub compatibility: MarketplaceCompatibility,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<MarketplaceAssets>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketplaceCompatibility {
    pub min_app_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_app_version: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketplaceAssets {
    pub icon: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
}

pub fn parse_marketplace_package(
    value: &Value,
) -> Result<MarketplacePackage, crate::RegistryError> {
    crate::validate_marketplace_package(value)?;
    serde_json::from_value(value.clone())
        .map_err(|e| crate::RegistryError::single(format!("invalid marketplace package: {e}")))
}
