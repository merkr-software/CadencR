//! Monorepo-aware LSP root resolution.
//!
//! `GET /api/lsp/root?workspace_root=...&file_path=...&language_id=...`
//!
//! In a monorepo the language server should root at the nearest ancestor
//! config for the *opened file* (e.g. that package's `tsconfig.json`), not the
//! feature working dir which may sit above several unrelated packages. This
//! endpoint walks UP from the file to the nearest directory containing one of
//! the catalog's `root_markers` for the file's language, bounded by the
//! feature root, and returns that directory. When no marker is found (or the
//! language has none) it returns the feature root unchanged — so single-package
//! repos and whole-tree servers keep their current behavior.

use std::path::{Path, PathBuf};

use axum::extract::Query;
use axum::Json;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::AppError;

use super::catalog;

#[derive(Debug, Deserialize, IntoParams)]
pub struct LspRootParams {
    /// Absolute feature working dir; the resolved root never escapes this.
    pub workspace_root: String,
    /// Absolute path (or path under `workspace_root`) of the opened file.
    pub file_path: String,
    /// LSP `TextDocumentItem` language id (e.g. `"typescript"`). Selects which
    /// catalog `root_markers` to look for when no concrete `lsp_id` is given.
    pub language_id: String,
    /// Optional concrete server id (e.g. `"tsgo"`). When present its
    /// `root_markers` are used, so the resolved root matches the exact server
    /// the renderer is about to start. Falls back to the language default.
    #[serde(default)]
    pub lsp_id: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct LspRootResponse {
    /// Absolute resolved LSP root. The feature root when no marker matched.
    pub root: String,
}

/// Resolve the nearest ancestor root for `file_path`, bounded by
/// `workspace_root`. Pure + filesystem-reading, but takes no app state so it's
/// unit-testable with a tempdir.
#[utoipa::path(
    get,
    path = "/api/lsp/root",
    params(LspRootParams),
    responses(
        (status = 200, body = LspRootResponse),
        (status = 400, description = "Invalid path or path outside the worktree"),
    )
)]
pub async fn lsp_root_handler(
    Query(params): Query<LspRootParams>,
) -> Result<Json<LspRootResponse>, AppError> {
    let workspace_root = canonical_workspace_root(&params.workspace_root)?;
    let start_dir = validated_start_dir(&workspace_root, &params.file_path)?;
    let entry = match &params.lsp_id {
        Some(lsp_id) => catalog::lookup_by_id(lsp_id),
        None => catalog::lookup(&params.language_id),
    };
    let markers = entry.map(|entry| entry.root_markers).unwrap_or(&[]);
    let root = nearest_root(&workspace_root, &start_dir, markers);
    Ok(Json(LspRootResponse {
        root: root.to_string_lossy().into_owned(),
    }))
}

/// Canonicalize the feature root, rejecting relative / nonexistent dirs.
fn canonical_workspace_root(raw: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "workspace_root must be absolute, got {raw:?}"
        )));
    }
    std::fs::canonicalize(&path)
        .map_err(|e| AppError::BadRequest(format!("cannot resolve workspace_root: {e}")))
}

/// Resolve the directory to start the upward walk from: the parent dir of the
/// opened file, canonicalized and confirmed to be inside `workspace_root`. The
/// file itself may not exist yet (unsaved buffer), so we canonicalize the
/// parent rather than the file.
fn validated_start_dir(workspace_root: &Path, file_path: &str) -> Result<PathBuf, AppError> {
    // Accept both absolute paths and paths relative to the workspace root.
    let abs = {
        let p = Path::new(file_path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            workspace_root.join(p)
        }
    };
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::BadRequest("file_path has no parent directory".into()))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| AppError::BadRequest(format!("cannot resolve file directory: {e}")))?;
    if !canonical_parent.starts_with(workspace_root) {
        return Err(AppError::BadRequest(
            "file_path is outside the workspace".into(),
        ));
    }
    Ok(canonical_parent)
}

/// Walk up from `start_dir` to `workspace_root` (inclusive), returning the
/// first directory containing any of `markers`. Falls back to `workspace_root`
/// when no marker matches or `markers` is empty. `start_dir` is assumed to be
/// inside `workspace_root` (validated by the caller).
fn nearest_root(workspace_root: &Path, start_dir: &Path, markers: &[&str]) -> PathBuf {
    if markers.is_empty() {
        return workspace_root.to_path_buf();
    }
    let mut dir = start_dir;
    loop {
        if dir_has_marker(dir, markers) {
            return dir.to_path_buf();
        }
        if dir == workspace_root {
            break;
        }
        match dir.parent() {
            Some(parent) if parent.starts_with(workspace_root) => dir = parent,
            _ => break,
        }
    }
    workspace_root.to_path_buf()
}

fn dir_has_marker(dir: &Path, markers: &[&str]) -> bool {
    markers.iter().any(|m| dir.join(m).exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn finds_nearest_tsconfig_in_nested_package() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        // monorepo/  (package.json)
        //   packages/app/ (tsconfig.json)  <- opened file lives here
        fs::write(root.join("package.json"), "{}").unwrap();
        let pkg = root.join("packages/app");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("tsconfig.json"), "{}").unwrap();
        let src = pkg.join("src");
        fs::create_dir_all(&src).unwrap();

        let markers = &["tsconfig.json", "jsconfig.json", "package.json"];
        let resolved = nearest_root(&root, &fs::canonicalize(&src).unwrap(), markers);
        assert_eq!(resolved, pkg);
    }

    #[test]
    fn falls_back_to_workspace_root_when_no_marker() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let nested = root.join("a/b/c");
        fs::create_dir_all(&nested).unwrap();
        let markers = &["tsconfig.json"];
        let resolved = nearest_root(&root, &fs::canonicalize(&nested).unwrap(), markers);
        assert_eq!(resolved, root);
    }

    #[test]
    fn empty_markers_returns_workspace_root() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let nested = root.join("x");
        fs::create_dir_all(&nested).unwrap();
        // Even with a tsconfig present, no markers means no rooting.
        fs::write(nested.join("tsconfig.json"), "{}").unwrap();
        let resolved = nearest_root(&root, &fs::canonicalize(&nested).unwrap(), &[]);
        assert_eq!(resolved, root);
    }

    #[test]
    fn prefers_top_level_marker_when_only_root_has_one() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::write(root.join("Cargo.toml"), "").unwrap();
        let src = root.join("crate-a/src");
        fs::create_dir_all(&src).unwrap();
        let resolved = nearest_root(&root, &fs::canonicalize(&src).unwrap(), &["Cargo.toml"]);
        assert_eq!(resolved, root);
    }

    #[test]
    fn validated_start_dir_rejects_escape() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("inside")).unwrap();
        // A traversal that resolves outside the workspace must be rejected.
        let err = validated_start_dir(&root, "../etc/passwd");
        assert!(matches!(err, Err(AppError::BadRequest(_))));
    }

    #[test]
    fn validated_start_dir_accepts_relative_inside() {
        let tmp = tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let dir = root.join("pkg/src");
        fs::create_dir_all(&dir).unwrap();
        let got = validated_start_dir(&root, "pkg/src/main.ts").unwrap();
        assert_eq!(got, fs::canonicalize(&dir).unwrap());
    }
}
