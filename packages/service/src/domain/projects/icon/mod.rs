//! Project icon discovery and delivery.
//!
//! A project can display a logo taken from its own repository instead of the
//! generic accent dot. Two endpoints back that:
//!
//! - `GET /api/projects/{id}/icon-candidates` scans the repo's git-tracked
//!   files for plausible logos and returns them ranked, best guess first.
//! - `GET /api/projects/{id}/icon` serves the bytes of whichever file the user
//!   settled on (the `icon_path` project setting).
//!
//! The scan is deliberately cheap — one `git ls-files` plus a `stat` per image
//! — so the frontend can re-run it on demand from Project Settings.

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxumPath, Query, State};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::domain::projects::service;
use crate::domain::settings_store;
use crate::error::AppError;
mod scoring;

use scoring::score_path;

use crate::domain::editor::service::validate_path;
use crate::shared::git_cli;
// The shared image allowlist plus SVG — the single most common logo format.
use crate::shared::image_file::image_or_svg_mime_for_path as icon_mime_for_path;
use crate::shared::image_file::image_response;

/// Project setting holding the chosen icon. Values are project-relative when
/// the file lives inside the repo and absolute when picked from elsewhere.
pub const ICON_SETTING_KEY: &str = "icon_path";

/// Upper bound on how many candidates a scan returns. Asset-heavy repos can
/// hold hundreds of images; ranking floats the real logos to the top, so a cap
/// keeps the payload and the picker grid manageable.
const MAX_CANDIDATES: usize = 40;

/// Icons are decoded by the renderer and held in memory as blob URLs, so they
/// are capped far below the editor's 25 MB image ceiling.
const MAX_ICON_BYTES: u64 = 4 * 1024 * 1024;

/// One plausible logo found in the repository.
#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ProjectIconCandidate {
    /// Path relative to the project root, as git reported it.
    pub path: String,
    /// File name alone, for display.
    pub name: String,
    pub size_bytes: i64,
}

/// Turn a git-reported path into a candidate, dropping anything unreadable or
/// oversized. Costs one `stat`, so only ranked survivors reach it.
async fn build_candidate(relative: &str, root: &Path) -> Option<ProjectIconCandidate> {
    let metadata = tokio::fs::metadata(root.join(relative)).await.ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return None;
    }

    Some(ProjectIconCandidate {
        name: Path::new(relative)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative)
            .to_string(),
        size_bytes: metadata.len() as i64,
        path: relative.to_string(),
    })
}

/// Scan the project's git-tracked files for plausible logos, best first.
///
/// Ranking is pure string work, so scoring and truncation happen *before* any
/// filesystem access: a monorepo can track thousands of images, and statting
/// every one of them to build a list that keeps 40 would stall a runtime worker
/// for no benefit.
pub async fn scan_icon_candidates(
    state: &AppState,
    project_id: i64,
) -> Result<Vec<ProjectIconCandidate>, AppError> {
    let root = service::resolve_project_root(&state.read_pool, project_id).await?;
    let listing = crate::shared::git_z::paths(&git_cli::run_git(&["ls-files", "-z"], &root).await?);

    let mut ranked: Vec<(i32, &str)> = listing
        .iter()
        .map(String::as_str)
        .filter(|entry| icon_mime_for_path(Path::new(entry)).is_some())
        .map(|entry| (score_path(entry), entry))
        .collect();

    // Highest score first; ties broken by path so results are stable between
    // scans (the UI presents the first hit as the suggested pick).
    ranked.sort_by(|(a_score, a_path), (b_score, b_path)| {
        b_score.cmp(a_score).then_with(|| a_path.cmp(b_path))
    });
    ranked.truncate(MAX_CANDIDATES);

    let mut candidates = Vec::with_capacity(ranked.len());
    for (_, relative) in ranked {
        if let Some(candidate) = build_candidate(relative, &root).await {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

/// Resolve the stored `icon_path` setting to an absolute file path.
///
/// Relative values are joined onto the project root; absolute values are used
/// verbatim, because the native file dialog deliberately lets the user pick a
/// logo living outside the repository.
///
/// That means this route will read any path the setting names, and `icon_path`
/// is writable through the generic project-settings PUT — so an authenticated
/// caller can point it at an arbitrary file and read it back, provided the file
/// has an image extension and is under `MAX_ICON_BYTES`. That is bounded by the
/// same auth layer that already exposes the editor's file-read routes, and it
/// grants no access the caller lacks elsewhere in the API, so it is accepted
/// rather than guarded. Do not relax the extension or size checks.
async fn resolve_icon_path(state: &AppState, project_id: i64) -> Result<PathBuf, AppError> {
    let stored = settings_store::project_get(&state.read_pool, project_id, ICON_SETTING_KEY)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::NotFound("no icon set for this project".to_string()))?;

    let candidate = PathBuf::from(&stored);
    if candidate.is_absolute() {
        return Ok(candidate);
    }
    let root = service::resolve_project_root(&state.read_pool, project_id).await?;
    Ok(root.join(candidate))
}

/// Resolve a caller-supplied, project-relative path for preview.
///
/// Unlike the stored setting, this value *does* come from the request, so it
/// goes through the shared `validate_path` containment check — the same one the
/// sibling `read-image` route uses. Absolute paths and `../` traversal both
/// fail it, because the join canonicalizes outside the root.
/// `root` must already be canonical — `resolve_project_root` guarantees that.
fn resolve_preview_path(root: &Path, requested: &str) -> Result<PathBuf, AppError> {
    validate_path(root, requested)
}

#[derive(Debug, Deserialize)]
pub struct IconQuery {
    /// Optional project-relative path to preview. When omitted, the project's
    /// configured icon is served.
    pub path: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/projects/{id}/icon-candidates",
    params(("id" = i64, Path,)),
    responses((status = 200, body = Vec<ProjectIconCandidate>))
)]
pub async fn scan_project_icons_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<Vec<ProjectIconCandidate>>, AppError> {
    Ok(Json(scan_icon_candidates(&state, id).await?))
}

/// Serve icon bytes: the project's configured icon, or — with `?path=` — a
/// candidate from the repo so the picker can render thumbnails.
///
/// Excluded from the OpenAPI `paths(...)` set on purpose — orval would emit a
/// useless `unknown`-typed hook for a binary body, so the frontend calls this
/// directly through the API client (see `read-image` for the same precedent).
pub async fn get_project_icon_handler(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<i64>,
    Query(query): Query<IconQuery>,
) -> Result<Response, AppError> {
    let path = match query.path.as_deref().filter(|v| !v.trim().is_empty()) {
        Some(requested) => {
            let root = service::resolve_project_root(&state.read_pool, id).await?;
            resolve_preview_path(&root, requested)?
        }
        None => resolve_icon_path(&state, id).await?,
    };
    let mime = icon_mime_for_path(&path).ok_or_else(|| {
        AppError::BadRequest(format!(
            "unsupported icon format: {}",
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("icon")
        ))
    })?;

    // Stat before read so an oversized file is rejected rather than buffered.
    let metadata = tokio::fs::metadata(&path)
        .await
        .ok()
        // A directory named `logo.png` passes the extension check, so require a
        // real file here rather than letting the read fail as a 500.
        .filter(std::fs::Metadata::is_file)
        .ok_or_else(|| AppError::NotFound(format!("icon file not found: {}", path.display())))?;
    if metadata.len() > MAX_ICON_BYTES {
        return Err(AppError::BadRequest(format!(
            "icon file is too large ({} bytes, max {MAX_ICON_BYTES})",
            metadata.len()
        )));
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::internal(format!("failed to read icon: {e}")))?;
    image_response(bytes, mime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_svg_but_not_icns() {
        assert_eq!(
            icon_mime_for_path(Path::new("logo.svg")),
            Some("image/svg+xml")
        );
        assert_eq!(icon_mime_for_path(Path::new("LOGO.PNG")), Some("image/png"));
        assert_eq!(icon_mime_for_path(Path::new("app.icns")), None);
        assert_eq!(icon_mime_for_path(Path::new("readme.md")), None);
    }

    #[test]
    fn preview_path_rejects_absolute_and_traversal() {
        // Canonical root: on macOS `temp_dir()` is a symlink, and validate_path
        // compares against an already-canonical root.
        let dir = std::env::temp_dir().canonicalize().unwrap();
        assert!(matches!(
            resolve_preview_path(&dir, "/etc/passwd"),
            Err(AppError::BadRequest(_))
        ));
        // `../` climbing out of the root must not resolve, whether it lands on
        // a real file (BadRequest) or a missing one (NotFound).
        assert!(resolve_preview_path(&dir, "../../../../../../etc/passwd").is_err());
    }

    #[test]
    fn preview_path_accepts_file_inside_the_project() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join("cadencr-icon-preview-test");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("logo.png"), b"x").unwrap();

        let resolved = resolve_preview_path(&root, "logo.png").unwrap();
        assert!(resolved.ends_with("logo.png"));

        std::fs::remove_dir_all(&root).ok();
    }
}
