use axum::extract::{Json, Query, State};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::file_size;
use super::service;
use super::tree_all;
use super::tree_count;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(get, path = "/api/editor/read",
    params(ReadFileParams),
    responses((status = 200, body = ReadFileResponse)))]
pub async fn read_file_handler(
    State(state): State<AppState>,
    Query(params): Query<ReadFileParams>,
) -> Result<axum::Json<ReadFileResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let path = service::validate_path(&project_root, &params.file_path)?;

    let resp = tokio::task::spawn_blocking(move || -> Result<ReadFileResponse, AppError> {
        if service::is_binary(&path).map_err(|e| AppError::Internal(e.to_string()))? {
            return Err(AppError::BadRequest(
                "Binary files cannot be opened".to_string(),
            ));
        }

        // High OOM guard only — text files of any reasonable size open; very
        // large ones open read-only on the frontend via the `large` flag.
        const MAX_FILE_SIZE: u64 = 100 * 1024 * 1024;
        let metadata = std::fs::metadata(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::NotFound(format!("File not found: {}", path.display()))
            }
            _ => AppError::Internal(e.to_string()),
        })?;
        if metadata.len() > MAX_FILE_SIZE {
            return Err(AppError::BadRequest(
                "File exceeds 100MB size limit".to_string(),
            ));
        }

        let content = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                AppError::NotFound(format!("File not found: {}", path.display()))
            }
            std::io::ErrorKind::PermissionDenied => {
                AppError::BadRequest(format!("Permission denied: {}", path.display()))
            }
            _ => AppError::Internal(e.to_string()),
        })?;

        let line_count = content.lines().count() as u64;
        let large = metadata.len() >= file_size::LARGE_FILE_OPEN_BYTES;

        Ok(ReadFileResponse {
            content,
            line_count,
            large,
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(resp))
}

#[utoipa::path(post, path = "/api/editor/write",
    request_body = WriteFileRequest,
    responses((status = 200, body = WriteFileResponse)))]
pub async fn write_file_handler(
    State(state): State<AppState>,
    Json(body): Json<WriteFileRequest>,
) -> Result<axum::Json<WriteFileResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;
    let path = service::validate_path_for_write(&project_root, &body.file_path)?;
    let content = body.content;

    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        std::fs::write(&path, &content).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                AppError::BadRequest(format!("Permission denied: {}", path.display()))
            }
            _ => AppError::Internal(e.to_string()),
        })
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(WriteFileResponse { success: true }))
}

#[utoipa::path(get, path = "/api/editor/tree",
    params(TreeParams),
    responses((status = 200, body = Vec<FileTreeEntry>)))]
pub async fn tree_handler(
    State(state): State<AppState>,
    Query(params): Query<TreeParams>,
) -> Result<axum::Json<Vec<FileTreeEntry>>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let dir_path_param = params.dir_path;

    let entries = tokio::task::spawn_blocking(move || -> Result<Vec<FileTreeEntry>, AppError> {
        let dir_path = service::validate_path(&project_root, &dir_path_param)?;

        let gitignore = service::build_gitignore(&project_root);

        let mut entries: Vec<FileTreeEntry> = Vec::new();

        let read_dir = std::fs::read_dir(&dir_path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound("Directory not found".to_string()),
            std::io::ErrorKind::PermissionDenied => {
                AppError::BadRequest("Permission denied".to_string())
            }
            _ => AppError::Internal(e.to_string()),
        })?;

        for entry in read_dir {
            let entry = entry.map_err(|e| AppError::Internal(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().to_string();

            let metadata = entry
                .metadata()
                .map_err(|e| AppError::Internal(e.to_string()))?;
            let is_dir = metadata.is_dir();

            let relative = entry
                .path()
                .strip_prefix(&project_root)
                .unwrap_or(entry.path().as_path())
                .to_string_lossy()
                .to_string();

            let is_gitignored = service::is_gitignored(gitignore.as_ref(), &entry.path(), is_dir);

            entries.push(FileTreeEntry {
                name,
                path: relative,
                is_dir,
                is_gitignored,
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(entries))
}

#[utoipa::path(get, path = "/api/editor/tree-all",
    params(TreeAllParams),
    responses((status = 200, body = Vec<FileTreeEntry>)))]
pub async fn tree_all_handler(
    State(state): State<AppState>,
    Query(params): Query<TreeAllParams>,
) -> Result<axum::Json<Vec<FileTreeEntry>>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let exclude_gitignored = params.exclude_gitignored;

    let entries = tokio::task::spawn_blocking(move || {
        tree_all::build_entries(&project_root, exclude_gitignored)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(entries))
}

#[utoipa::path(get, path = "/api/editor/tree-count",
    params(TreeCountParams),
    responses((status = 200, body = TreeCountResponse)))]
pub async fn tree_count_handler(
    State(state): State<AppState>,
    Query(params): Query<TreeCountParams>,
) -> Result<axum::Json<TreeCountResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let exclude_gitignored = params.exclude_gitignored;

    let count = tokio::task::spawn_blocking(move || {
        tree_count::count_entries(&project_root, exclude_gitignored)
    })
    .await
    .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(TreeCountResponse { count }))
}

// ---------------------------------------------------------------------------
// Content search types & handler
// ---------------------------------------------------------------------------

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

#[utoipa::path(get, path = "/api/editor/content-search",
    params(ContentSearchParams),
    responses((status = 200, body = ContentSearchResponse)))]
pub async fn content_search_handler(
    State(state): State<AppState>,
    Query(params): Query<ContentSearchParams>,
) -> Result<axum::Json<ContentSearchResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;

    let resp = tokio::task::spawn_blocking(move || service::content_search(&project_root, &params))
        .await
        .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(resp))
}

// ---------------------------------------------------------------------------
// File search types & handler
// ---------------------------------------------------------------------------

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

#[utoipa::path(get, path = "/api/editor/search",
    params(SearchParams),
    responses((status = 200, body = FileSearchResponse)))]
pub async fn search_handler(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<axum::Json<FileSearchResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    let query = params.query.unwrap_or_default();
    let include_dirs = params.include_dirs;

    let files: Vec<FileMatchResult> =
        tokio::task::spawn_blocking(move || -> Result<Vec<FileMatchResult>, AppError> {
            let matches = if query.is_empty() {
                service::recent_files(&project_root, 20, include_dirs)?
            } else {
                service::fuzzy_search_files(&project_root, &query, 50, include_dirs)?
            };
            Ok(matches
                .into_iter()
                .map(|m| FileMatchResult {
                    path: m.path,
                    positions: m.positions,
                    is_dir: m.is_dir,
                })
                .collect())
        })
        .await
        .map_err(|e| AppError::Internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(FileSearchResponse { files }))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn editor_router() -> Router<AppState> {
    Router::new()
        .route("/api/editor/read", get(read_file_handler))
        .route("/api/editor/write", post(write_file_handler))
        .route("/api/editor/tree", get(tree_handler))
        .route("/api/editor/tree-all", get(tree_all_handler))
        .route("/api/editor/tree-count", get(tree_count_handler))
        .route("/api/editor/search", get(search_handler))
        .route("/api/editor/content-search", get(content_search_handler))
}
