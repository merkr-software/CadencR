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
