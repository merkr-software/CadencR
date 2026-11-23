mod types;

use axum::extract::{Json, Query, State};
use axum::routing::{get, post};
use axum::Router;
use tokio_util::sync::CancellationToken;

use super::file_size;
use super::service;
use super::tree_all;
use super::tree_count;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;

pub use types::{
    ContentMatch, ContentSearchParams, ContentSearchResponse, FileMatchResult, FileSearchResponse,
    FileTreeEntry, ReadFileParams, ReadFileResponse, SearchParams, TreeAllParams, TreeCountParams,
    TreeCountResponse, TreeParams, WriteFileRequest, WriteFileResponse,
};

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
    let file_path = params.file_path;

    let resp = tokio::task::spawn_blocking(move || -> Result<ReadFileResponse, AppError> {
        let path = service::validate_path(&project_root, &file_path)?;
        if service::is_binary(&path).map_err(|e| AppError::internal(e.to_string()))? {
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
            _ => AppError::internal(e.to_string()),
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
            _ => AppError::internal(e.to_string()),
        })?;

        let line_count = content.lines().count() as u64;
        let large = file_size::is_large_file(metadata.len());

        Ok(ReadFileResponse {
            content,
            line_count,
            large,
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

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
    let file_path = body.file_path;
    let content = body.content;

    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let path = service::validate_path_for_write(&project_root, &file_path)?;
        service::write_file_no_follow(&path, content.as_bytes(), service::FileWriteMode::Replace)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    AppError::BadRequest(format!("Permission denied: {}", path.display()))
                }
                std::io::ErrorKind::AlreadyExists => {
                    AppError::BadRequest("Refusing to write through a symbolic link".into())
                }
                _ if e.raw_os_error() == Some(libc::ELOOP) => {
                    AppError::BadRequest("Refusing to write through a symbolic link".into())
                }
                _ => AppError::internal(e.to_string()),
            })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

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

        let ignore_rules = service::ignore_rules(&project_root);

        let mut entries: Vec<FileTreeEntry> = Vec::new();

        let read_dir = std::fs::read_dir(&dir_path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound("Directory not found".to_string()),
            std::io::ErrorKind::PermissionDenied => {
                AppError::BadRequest("Permission denied".to_string())
            }
            _ => AppError::internal(e.to_string()),
        })?;

        for entry in read_dir {
            let entry = entry.map_err(|e| AppError::internal(e.to_string()))?;
            let name = entry.file_name().to_string_lossy().to_string();

            let metadata = entry
                .metadata()
                .map_err(|e| AppError::internal(e.to_string()))?;
            let is_dir = metadata.is_dir();

            let relative = entry
                .path()
                .strip_prefix(&project_root)
                .unwrap_or(entry.path().as_path())
                .to_string_lossy()
                .to_string();

            let is_gitignored = ignore_rules.is_ignored(&entry.path(), is_dir);

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
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

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
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

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
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(TreeCountResponse { count }))
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

    let token = CancellationToken::new();
    let _cancel_guard = token.clone().drop_guard();
    let resp = tokio::task::spawn_blocking(move || {
        service::content_search_cancellable(&project_root, &params, token)
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    Ok(axum::Json(resp))
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
        .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

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
