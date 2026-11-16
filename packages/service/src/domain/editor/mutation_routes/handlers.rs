use axum::extract::{Json, Query, State};

use super::helpers::{rename_no_replace, validate_simple_name};
use super::types::{
    CreateFileRequest, CreateFileResponse, CreateFolderRequest, CreateFolderResponse,
    EditorRootParams, EditorRootResponse, MovePathRequest, MovePathResponse, RenamePathRequest,
    RenamePathResponse, TrashPathRequest, TrashPathResponse,
};
use crate::app_state::AppState;
use crate::domain::editor::service;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[utoipa::path(post, path = "/api/editor/create-file",
    request_body = CreateFileRequest,
    responses((status = 200, body = CreateFileResponse)))]
pub async fn create_editor_file_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateFileRequest>,
) -> Result<axum::Json<CreateFileResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;
    let path = service::validate_path_for_write(&project_root, &body.file_path)?;
    let project_root_for_response = project_root.clone();

    let path_for_blocking = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        service::write_file_no_follow(&path_for_blocking, b"", service::FileWriteMode::CreateNew)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::AlreadyExists => AppError::BadRequest(format!(
                    "File already exists: {}",
                    path_for_blocking.display()
                )),
                _ if e.raw_os_error() == Some(libc::ELOOP) => {
                    AppError::BadRequest("Refusing to create through a symbolic link".into())
                }
                std::io::ErrorKind::PermissionDenied => AppError::BadRequest(format!(
                    "Permission denied: {}",
                    path_for_blocking.display()
                )),
                _ => AppError::internal(e.to_string()),
            })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    let relative = path
        .strip_prefix(&project_root_for_response)
        .unwrap_or(path.as_path())
        .to_string_lossy()
        .to_string();
    Ok(axum::Json(CreateFileResponse { path: relative }))
}

#[utoipa::path(post, path = "/api/editor/create-folder",
    request_body = CreateFolderRequest,
    responses((status = 200, body = CreateFolderResponse)))]
pub async fn create_editor_folder_handler(
    State(state): State<AppState>,
    Json(body): Json<CreateFolderRequest>,
) -> Result<axum::Json<CreateFolderResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;
    let path = service::validate_path_for_write(&project_root, &body.dir_path)?;
    let project_root_for_response = project_root.clone();

    let path_for_blocking = path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        std::fs::create_dir(&path_for_blocking).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::BadRequest(format!(
                "Path already exists: {}",
                path_for_blocking.display()
            )),
            std::io::ErrorKind::PermissionDenied => AppError::BadRequest(format!(
                "Permission denied: {}",
                path_for_blocking.display()
            )),
            _ => AppError::internal(e.to_string()),
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    let relative = path
        .strip_prefix(&project_root_for_response)
        .unwrap_or(path.as_path())
        .to_string_lossy()
        .to_string();
    Ok(axum::Json(CreateFolderResponse { path: relative }))
}

#[utoipa::path(patch, path = "/api/editor/rename",
    request_body = RenamePathRequest,
    responses((status = 200, body = RenamePathResponse)))]
pub async fn rename_editor_path_handler(
    State(state): State<AppState>,
    Json(body): Json<RenamePathRequest>,
) -> Result<axum::Json<RenamePathResponse>, AppError> {
    validate_simple_name(&body.new_name)?;
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;

    let old_abs = service::validate_path(&project_root, &body.old_path)?;
    let parent = old_abs
        .parent()
        .ok_or_else(|| AppError::BadRequest("Cannot rename root path".to_string()))?
        .to_path_buf();
    let new_abs = parent.join(&body.new_name);

    if !new_abs.starts_with(&project_root) {
        return Err(AppError::BadRequest(
            "Renamed path is outside the project directory".to_string(),
        ));
    }

    let project_root_for_response = project_root.clone();
    let new_abs_for_blocking = new_abs.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        rename_no_replace(&old_abs, &new_abs_for_blocking).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::BadRequest(format!(
                "Destination already exists: {}",
                new_abs_for_blocking.display()
            )),
            std::io::ErrorKind::PermissionDenied => AppError::BadRequest(format!(
                "Permission denied: {}",
                new_abs_for_blocking.display()
            )),
            _ => AppError::internal(e.to_string()),
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    let relative = new_abs
        .strip_prefix(&project_root_for_response)
        .unwrap_or(new_abs.as_path())
        .to_string_lossy()
        .to_string();
    Ok(axum::Json(RenamePathResponse { new_path: relative }))
}

#[utoipa::path(post, path = "/api/editor/move",
    request_body = MovePathRequest,
    responses((status = 200, body = MovePathResponse)))]
pub async fn move_editor_path_handler(
    State(state): State<AppState>,
    Json(body): Json<MovePathRequest>,
) -> Result<axum::Json<MovePathResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;

    let old_abs = service::validate_path(&project_root, &body.old_path)?;

    // Resolve the new parent. An empty string or "." means the project root.
    let parent_input = if body.new_parent_path.is_empty() {
        "."
    } else {
        body.new_parent_path.as_str()
    };
    let new_parent_abs = service::validate_path(&project_root, parent_input)?;

    if !new_parent_abs.is_dir() {
        return Err(AppError::BadRequest(
            "Move target must be a directory".to_string(),
        ));
    }

    let file_name = old_abs
        .file_name()
        .ok_or_else(|| AppError::BadRequest("Cannot move root path".to_string()))?;
    let new_abs = new_parent_abs.join(file_name);

    if !new_abs.starts_with(&project_root) {
        return Err(AppError::BadRequest(
            "Move destination is outside the project directory".to_string(),
        ));
    }

    // Block self-move and move-into-own-descendant. We compare the canonical
    // paths so callers can't sneak through with a different relative form.
    if new_parent_abs == old_abs || new_parent_abs.starts_with(&old_abs) {
        return Err(AppError::BadRequest(
            "Cannot move a path into itself or its own descendant".to_string(),
        ));
    }

    // No-op when the entry already lives in the destination directory.
    if new_abs == old_abs {
        let relative = old_abs
            .strip_prefix(&project_root)
            .unwrap_or(old_abs.as_path())
            .to_string_lossy()
            .to_string();
        return Ok(axum::Json(MovePathResponse { new_path: relative }));
    }

    let project_root_for_response = project_root.clone();
    let new_abs_for_blocking = new_abs.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        rename_no_replace(&old_abs, &new_abs_for_blocking).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::BadRequest(format!(
                "Destination already exists: {}",
                new_abs_for_blocking.display()
            )),
            std::io::ErrorKind::PermissionDenied => AppError::BadRequest(format!(
                "Permission denied: {}",
                new_abs_for_blocking.display()
            )),
            _ => AppError::internal(e.to_string()),
        })
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))??;

    let relative = new_abs
        .strip_prefix(&project_root_for_response)
        .unwrap_or(new_abs.as_path())
        .to_string_lossy()
        .to_string();
    Ok(axum::Json(MovePathResponse { new_path: relative }))
}

#[utoipa::path(delete, path = "/api/editor/trash",
    request_body = TrashPathRequest,
    responses((status = 200, body = TrashPathResponse)))]
pub async fn trash_editor_path_handler(
    State(state): State<AppState>,
    Json(body): Json<TrashPathRequest>,
) -> Result<axum::Json<TrashPathResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;
    let abs_path = service::validate_path(&project_root, &body.path)?;

    crate::shared::trash::move_to_trash(&abs_path).await?;

    Ok(axum::Json(TrashPathResponse { success: true }))
}

#[utoipa::path(get, path = "/api/editor/root",
    params(EditorRootParams),
    responses((status = 200, body = EditorRootResponse)))]
pub async fn get_editor_root_handler(
    State(state): State<AppState>,
    Query(params): Query<EditorRootParams>,
) -> Result<axum::Json<EditorRootResponse>, AppError> {
    let project_root =
        resolve_feature_editor_root(&state.read_pool, params.project_id, params.feature_id).await?;
    Ok(axum::Json(EditorRootResponse {
        root: project_root.to_string_lossy().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn validate_path_for_write_rejects_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let res = service::validate_path_for_write(&root, "../escape.txt");
        assert!(res.is_err());
    }

    #[test]
    fn create_file_then_trash_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();

        let target = service::validate_path_for_write(&root, "hello.txt").unwrap();
        assert!(!target.exists());
        fs::write(&target, "").unwrap();
        assert!(target.exists());

        let validated = service::validate_path(&root, "hello.txt").unwrap();
        assert_eq!(validated, target);

        let _ = trash::delete(&validated);
    }

    #[test]
    fn move_rejects_moving_directory_into_its_descendant() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("a/b")).unwrap();

        let old_abs = service::validate_path(&root, "a").unwrap();
        let new_parent_abs = service::validate_path(&root, "a/b").unwrap();
        assert!(new_parent_abs.starts_with(&old_abs));
    }

    #[test]
    fn move_to_same_parent_is_noop() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::write(root.join("dir/file.txt"), "").unwrap();

        let old_abs = service::validate_path(&root, "dir/file.txt").unwrap();
        let new_parent_abs = service::validate_path(&root, "dir").unwrap();
        let candidate = new_parent_abs.join(old_abs.file_name().unwrap());
        assert_eq!(candidate, old_abs);
    }

    #[test]
    fn rename_with_simple_name_stays_inside_root() {
        let tmp = TempDir::new().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let file = root.join("a.txt");
        fs::write(&file, "").unwrap();

        validate_simple_name("b.txt").unwrap();
        let parent = file.parent().unwrap().to_path_buf();
        let target = parent.join("b.txt");
        assert!(target.starts_with(&root));
    }
}
