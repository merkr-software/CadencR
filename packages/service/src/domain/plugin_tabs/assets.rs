//! `GET /api/plugin-tabs/{id}/assets/{*path}`: a tab's static files.
//!
//! The Electron host relays every `cadencr-tab://<id>/…` request here, so this
//! is the guest's only source of bytes. Three rules keep it to the tab's own
//! build output:
//!
//!  - the path is a clean relative path whose segments never start with `.`
//!    and are never `node_modules` (no dot-files, no `.git`, no dependencies);
//!  - the manifest's `entry` passes the same rules, and its folder (the web
//!    root), symlinks followed, must stay inside the tab folder: the manifest is
//!    read without full validation, so an `entry` of `/etc/index.html` or a
//!    `dist` linked elsewhere must not move the web root off the tab;
//!  - the *resolved* path (symlinks followed) must still be inside the web root
//!    and pass the same segment rules (no `.git/config` or external files);
//!  - responses carry the CSP of `docs/CUSTOM_TABS.md` §5.2, `nosniff`,
//!    and `no-store`, so author rebuilds cannot be hidden by cached bundles.
//!
//! Bodies stream from disk. Opaque bytes are outside the OpenAPI surface.

use std::path::{Component, Path, PathBuf};

use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use cadencr_plugin_core::tab::read_tab_manifest;
mod stream;

use super::managed::policy::PolicySubject;
use super::{paths, registry};
use crate::error::AppError;

pub const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; \
script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; \
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// A single asset larger than this is not a tab bundle file.
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// Serve `path` from tab `id`'s web root — the directory holding the
/// manifest's `entry` — so the bundle's relative URLs (`./assets/…`) resolve
/// the way they do on any static host. An empty path serves the entry itself.
pub async fn serve(id: &str, path: &str) -> Result<Response, AppError> {
    let local_root = paths::tabs_dir();
    let managed_root = super::managed::storage::root();
    let (id, path) = (id.to_string(), path.to_string());
    let policy = super::managed::policy::current()?;
    let (file, length, lease) = tokio::task::spawn_blocking(move || {
        let selected = paths::resolve_plugin_directory()
            .id(&id)
            .local_root(&local_root)
            .managed_root(&managed_root)
            .call()?;
        let (file, length) = locate(selected.directory(), &id, &path)?;
        if let paths::PluginDirectory::Managed(lease) = &selected {
            let revision = lease.verify_asset(&file)?;
            // A blocked revision serves nothing (403 `PLUGIN_TAB_BLOCKED`);
            // an out-of-date policy still lets the page load.
            policy.require_not_blocked(PolicySubject::installed(
                &id,
                &revision.manifest.version,
                &revision.facts,
            ))?;
        }
        Ok::<_, AppError>((file, length, selected.into_lease()))
    })
    .await
    .map_err(|error| AppError::internal(format!("custom tab asset lookup failed: {error}")))??;
    let opened = tokio::fs::File::open(&file)
        .await
        .map_err(|error| AppError::internal(format!("cannot read custom tab asset: {error}")))?;
    Ok(response(
        stream::body(opened, lease),
        length,
        content_type(&file),
    ))
}

/// The file `path` names under the tab's web root, in one blocking hop: the
/// manifest's `entry` is read without the full folder inspection (this runs
/// for every asset of every mount and live reload), then the path resolved.
fn locate(dir: &Path, id: &str, path: &str) -> Result<(PathBuf, u64), AppError> {
    if !dir.is_dir() {
        return Err(registry::not_found(id));
    }
    let entry = read_tab_manifest(dir)
        .map(|manifest| manifest.entry)
        .ok_or_else(|| invalid_tab(id, "has no readable tab.json"))?;
    if !is_servable(&entry) {
        return Err(invalid_tab(id, "has an `entry` outside its folder"));
    }
    let (web_root, entry_file) = split_entry(&entry);
    let relative = if path.is_empty() { entry_file } else { path };
    if !is_servable(relative) {
        return Err(forbidden(relative));
    }
    resolve(&web_root_inside(dir, id, web_root, relative)?, relative)
}

/// The canonical web root, refused when (symlinks followed) it is not inside
/// the canonical tab folder. A missing web root (the tab is not built yet) is
/// a missing asset.
fn web_root_inside(
    dir: &Path,
    id: &str,
    web_root: &str,
    relative: &str,
) -> Result<PathBuf, AppError> {
    let canonical = |path: &Path| path.canonicalize().map_err(|_| asset_not_found(relative));
    let root = canonical(&dir.join(web_root))?;
    if root.starts_with(canonical(dir)?) {
        Ok(root)
    } else {
        Err(invalid_tab(id, "has a web root that leaves its folder"))
    }
}

/// `dist/index.html` → (`dist`, `index.html`); `index.html` → (``, `index.html`).
fn split_entry(entry: &str) -> (&str, &str) {
    entry.rsplit_once('/').unwrap_or(("", entry))
}

/// A clean relative path with no dot-segment and no `node_modules` segment.
pub fn is_servable(relative: &str) -> bool {
    cadencr_plugin_core::tab::is_clean_relative_path(relative)
        && relative
            .split('/')
            .all(|segment| !segment.starts_with('.') && segment != "node_modules")
}

/// Canonicalize `root/relative` and require it to be a regular file that stays
/// servable relative to the canonical web `root`. Returns it with its length.
fn resolve(root: &Path, relative: &str) -> Result<(PathBuf, u64), AppError> {
    let file = match root.join(relative).canonicalize() {
        Ok(file) => file,
        Err(_) => return Err(asset_not_found(relative)),
    };
    let inside = file
        .strip_prefix(root)
        .ok()
        .and_then(|rest| {
            rest.components()
                .map(|component| match component {
                    Component::Normal(segment) => segment.to_str(),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
        })
        .is_some_and(|segments| !segments.is_empty() && is_servable(&segments.join("/")));
    if !inside {
        return Err(forbidden(relative));
    }
    let metadata = std::fs::metadata(&file).map_err(|_| asset_not_found(relative))?;
    if !metadata.is_file() {
        return Err(asset_not_found(relative));
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(forbidden(relative));
    }
    Ok((file, metadata.len()))
}

fn response(body: Body, length: u64, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// By extension; images come from the shared image table, and unknown types
/// are `application/octet-stream`, which with `nosniff` a browser will neither
/// render nor execute.
pub fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        _ => crate::shared::image_file::image_or_svg_mime_for_path(path)
            .unwrap_or("application/octet-stream"),
    }
}

fn invalid_tab(id: &str, problem: &str) -> AppError {
    AppError::coded(
        StatusCode::UNPROCESSABLE_ENTITY,
        "PLUGIN_TAB_INVALID",
        format!("custom tab `{id}` {problem}"),
    )
}

fn forbidden(relative: &str) -> AppError {
    AppError::coded(
        StatusCode::FORBIDDEN,
        "PLUGIN_TAB_ASSET_FORBIDDEN",
        format!("`{relative}` is not a servable custom tab asset"),
    )
}

fn asset_not_found(relative: &str) -> AppError {
    AppError::coded(
        StatusCode::NOT_FOUND,
        "PLUGIN_TAB_ASSET_NOT_FOUND",
        format!("no custom tab asset `{relative}`"),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::write_tab;

    fn code(error: AppError) -> &'static str {
        match error {
            AppError::Coded { code, .. } => code,
            other => panic!("unexpected {other:?}"),
        }
    }

    fn built_tab() -> PathBuf {
        let dir = write_tab("graph", serde_json::json!({}));
        std::fs::create_dir_all(dir.join("dist/assets")).unwrap();
        std::fs::write(dir.join("dist/index.html"), "<!doctype html>").unwrap();
        std::fs::write(dir.join("dist/assets/app.js"), "console.log(1)").unwrap();
        dir
    }

    #[test]
    fn servable_paths_exclude_dot_segments_and_dependencies() {
        for ok in ["dist/index.html", "dist/assets/app.js", "icon.svg"] {
            assert!(is_servable(ok), "{ok}");
        }
        for bad in [
            "",
            ".env",
            "dist/.hidden",
            ".git/config",
            "node_modules/x/index.js",
            "dist/node_modules/a.js",
            "../x",
            "/etc/passwd",
            "a\\b",
            "dist//a",
        ] {
            assert!(!is_servable(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn serves_entry_and_files_with_security_headers() {
        built_tab();
        let response = serve("graph", "").await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            CONTENT_SECURITY_POLICY
        );
        let script = serve("graph", "assets/app.js").await.unwrap();
        assert_eq!(
            script.headers()[header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(script.headers()[header::CONTENT_LENGTH], "14");
        let body = axum::body::to_bytes(script.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"console.log(1)");
        assert_eq!(content_type(Path::new("a.BMP")), "image/bmp");
        assert_eq!(content_type(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("a.exe")), "application/octet-stream");
    }

    #[tokio::test]
    async fn refuses_traversal_dot_files_and_missing_files() {
        let dir = built_tab();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        assert_eq!(
            code(serve("graph", "../graph/tab.json").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_FORBIDDEN"
        );
        assert_eq!(
            code(serve("graph", ".env").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_FORBIDDEN"
        );
        assert_eq!(
            code(serve("graph", "missing.js").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_NOT_FOUND"
        );
        assert_eq!(
            code(serve("graph", "assets").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_NOT_FOUND"
        );
        // The web root is the entry's folder: sources and the manifest stay out.
        assert_eq!(
            code(serve("graph", "tab.json").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_NOT_FOUND"
        );
        std::fs::remove_dir_all(dir.join("dist")).unwrap();
        assert_eq!(
            code(serve("graph", "").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_NOT_FOUND"
        );
        assert_eq!(
            code(serve("absent", "").await.unwrap_err()),
            "PLUGIN_TAB_NOT_FOUND"
        );
        assert_eq!(
            code(serve("..", "x").await.unwrap_err()),
            "PLUGIN_TAB_ID_INVALID"
        );
    }

    #[tokio::test]
    async fn an_entry_outside_the_tab_folder_serves_nothing() {
        for entry in ["/etc/index.html", "../other/index.html", ".git/index.html"] {
            write_tab("graph", serde_json::json!({ "entry": entry }));
            assert_eq!(
                code(serve("graph", "").await.unwrap_err()),
                "PLUGIN_TAB_INVALID",
                "{entry}"
            );
            assert_eq!(
                code(serve("graph", "passwd").await.unwrap_err()),
                "PLUGIN_TAB_INVALID",
                "{entry}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_web_root_linked_outside_the_tab_folder_serves_nothing() {
        use std::os::unix::fs::symlink;
        let dir = write_tab("graph", serde_json::json!({}));
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("index.html"), "<!doctype html>").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(outside.path(), dir.join("dist")).unwrap();
        for path in ["", "secret.txt"] {
            assert_eq!(
                code(serve("graph", path).await.unwrap_err()),
                "PLUGIN_TAB_INVALID",
                "{path}"
            );
        }
        // A link that stays inside the tab folder is fine.
        std::fs::remove_file(dir.join("dist")).unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build/index.html"), "<!doctype html>").unwrap();
        symlink(dir.join("build"), dir.join("dist")).unwrap();
        assert_eq!(serve("graph", "").await.unwrap().status(), StatusCode::OK);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_cannot_escape_or_reach_hidden_files() {
        use std::os::unix::fs::symlink;
        let dir = built_tab();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/config"), "[core]").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        symlink(outside.path().join("secret.txt"), dir.join("dist/leak.txt")).unwrap();
        symlink(dir.join(".git/config"), dir.join("dist/config.txt")).unwrap();
        symlink(dir.join("dist/index.html"), dir.join("dist/alias.html")).unwrap();
        assert_eq!(
            code(serve("graph", "leak.txt").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_FORBIDDEN"
        );
        assert_eq!(
            code(serve("graph", "config.txt").await.unwrap_err()),
            "PLUGIN_TAB_ASSET_FORBIDDEN"
        );
        assert_eq!(
            serve("graph", "alias.html").await.unwrap().status(),
            StatusCode::OK
        );
    }
}
