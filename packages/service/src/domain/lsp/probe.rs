//! Installed LSP inventory exposed to settings and the editor.
use super::catalog::ServerRole;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LspLanguage {
    pub id: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
}
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ServerProbe {
    pub lsp_id: String,
    pub name: String,
    pub description: String,
    pub bin_name: String,
    pub args: Vec<String>,
    pub language_ids: Vec<String>,
    pub languages: Vec<LspLanguage>,
    pub root_markers: Vec<String>,
    pub role: ServerRole,
    pub status: ServerProbeStatus,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Installation is always explicit through the marketplace.
    pub downloadable: bool,
    pub initialization_options: Value,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerProbeStatus {
    OnPath,
    Managed,
    Legacy,
    Invalid,
}
