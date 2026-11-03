//! Signed marketplace language-server metadata. Archives contain prepared code only.
use crate::MarketplaceHost;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspPackage {
    pub lsp: LspDescriptor,
    pub host: MarketplaceHost,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspDescriptor {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub repository: String,
    pub license: String,
    pub protocol_version: u32,
    pub languages: Vec<LspLanguage>,
    pub root_markers: Vec<String>,
    pub role: LspRole,
    pub args: Vec<String>,
    pub initialization_options: Value,
    pub distribution: LspDistribution,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspLanguage {
    pub id: String,
    /// Literal suffixes without a leading dot, for example `tsx`.
    pub extensions: Vec<String>,
    /// Exact case-sensitive file basenames, for example `Dockerfile`.
    pub filenames: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspRole {
    TypeChecker,
    Linter,
    Formatter,
    General,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspDistribution {
    /// Explicit signed mirror origin, when different from the author's repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub binary: BTreeMap<String, LspTarget>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspTarget {
    pub archive: String,
    pub sha256: String,
    pub size: u64,
    pub entry: String,
    pub entry_sha256: String,
    pub entry_size: u64,
    pub runtime: LspRuntime,
}
/// Node means a prepared JS bundle, including its dependencies. The host only
/// launches an existing Node executable; installation never runs npm or scripts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspRuntime {
    Native,
    Node,
}
