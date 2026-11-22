use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ReadFileParams {
    pub project_id: i64,
    /// Feature id scopes the read to the feature's worktree when one is
    /// active. When absent, the read resolves against the project root.
    #[serde(default)]
    pub feature_id: Option<i64>,
    pub file_path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ReadFileResponse {
    pub content: String,
    pub line_count: u64,
    /// True when the file is at or above `file_size::LARGE_FILE_OPEN_BYTES`.
    /// The frontend opens these read-only with language features disabled.
    pub large: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WriteFileRequest {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WriteFileResponse {
    pub success: bool,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct TreeParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    #[serde(default = "default_dir_path")]
    pub dir_path: String,
}

fn default_dir_path() -> String {
    ".".to_string()
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct TreeAllParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    /// When true, gitignored files are omitted from the result — fast,
    /// because the walker skips `node_modules`, `target`, etc. wholesale.
    /// When false (default) the walker traverses everything so the UI can
    /// display all files (gitignored dimmed). Callers that want the tree
    /// to paint quickly should issue the `exclude_gitignored=true` query
    /// first and then merge in the `exclude_gitignored=false` response.
    #[serde(default)]
    pub exclude_gitignored: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_gitignored: bool,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct TreeCountParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    /// When true, gitignored sub-trees (`node_modules`, `target`, …) are not
    /// counted — matching the fast `tree-all` walk the editor renders.
    #[serde(default)]
    pub exclude_gitignored: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TreeCountResponse {
    pub count: u64,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ContentSearchParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default = "default_true")]
    pub respect_gitignore: bool,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
    #[serde(default = "default_content_limit")]
    pub limit: usize,
}

fn default_true() -> bool {
    true
}

fn default_content_limit() -> usize {
    500
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentMatch {
    pub path: String,
    pub line_number: u64,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentSearchResponse {
    pub matches: Vec<ContentMatch>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct SearchParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    pub query: Option<String>,
    /// Include directories in the results (used by the `@` file-mention
    /// picker). Defaults to false so the file-open palette stays files-only.
    #[serde(default)]
    pub include_dirs: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FileMatchResult {
    pub path: String,
    pub positions: Vec<u32>,
    pub is_dir: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FileSearchResponse {
    pub files: Vec<FileMatchResult>,
}
