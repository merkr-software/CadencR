use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub struct NeovimStartResponse {
    pub version: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NeovimDetectResponse {
    pub available: bool,
}

/// Request to open a file in a feature's Neovim. `line` and `col` are
/// 1-indexed, matching how a `file.rs:240:2` reference reads.
#[allow(dead_code)]
#[derive(Deserialize, ToSchema)]
pub struct OpenFileRequest {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
}
