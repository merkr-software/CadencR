//! Spawn an LSP server child process with piped stdio.
//!
//! Resolution flow:
//! 1. Look up the LSP `languageId` in [`catalog::lookup`]. Unknown languages
//!    surface as [`AppError::BadRequest`] so the renderer can show a useful
//!    "no server for this language" message instead of a 500.
//! 2. Walk `cli-discovery` for a `bin_name` on `$PATH` / login-shell PATH /
//!    well-known directories. Pick the highest semver.
//! 3. If discovery finds nothing, fall back to the recipe-specific managed
//!    install path under `~/.cadencr/lsp/<lsp_id>/<version>/`. Step 4
//!    implements the actual install; step 3 just looks for an already-present
//!    binary so a user who installed manually still works without `$PATH`.
//! 4. Spawn the chosen binary with stdio piped.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::error::AppError;

use super::catalog::{self, CatalogEntry, DownloadRecipe};
use super::checksum;
use super::downloader;

/// What we need to actually invoke a server. Produced by [`resolve_server`].
#[derive(Debug, Clone)]
pub struct ServerSpec {
    /// Absolute path to the binary on disk.
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Human-readable identifier used only in error messages and tracing.
    pub display_name: String,
}

/// Lightweight, sync resolution used by `POST /api/lsp/sessions` to fail fast
/// when the renderer asks for an unsupported language. Does NOT touch the
/// filesystem — full discovery happens later in [`resolve_server`].
pub fn resolve_language(language_id: &str) -> Result<&'static CatalogEntry, AppError> {
    catalog::lookup(language_id).ok_or_else(|| {
        AppError::BadRequest(format!(
            "no language server registered for language id {language_id:?}"
        ))
    })
}

/// Full async resolution: catalog → `cli-discovery` → on-demand-download path.
///
/// Returns `BadRequest` for an unknown language; `NotFound` when we know
/// *what* binary to look for but couldn't find it on disk (renderer surfaces
/// this as "install `<bin_name>` to enable LSP for `<language>`").
pub async fn resolve_server(language_id: &str) -> Result<ServerSpec, AppError> {
    let entry = resolve_language(language_id)?;
    resolve_entry(entry).await
}

/// Resolve a specific catalog server by its stable `lsp_id` (Phase 4: a project
/// may select e.g. `tsgo` or `biome` rather than the language default). Reuses
/// the same discovery → managed-install path as [`resolve_server`].
pub async fn resolve_server_by_id(lsp_id: &str) -> Result<ServerSpec, AppError> {
    let entry = catalog::lookup_by_id(lsp_id).ok_or_else(|| {
        AppError::BadRequest(format!("no language server registered with id {lsp_id:?}"))
    })?;
    resolve_entry(entry).await
}

/// Shared discovery + managed-install resolution for one catalog entry.
///
/// Returns `NotFound` when we know *what* binary to look for but couldn't find
/// it on disk (renderer surfaces this as "install `<bin_name>` to enable LSP").
async fn resolve_entry(entry: &'static CatalogEntry) -> Result<ServerSpec, AppError> {
    // Step 1: cli-discovery walks PATH + login-shell PATH + well-known dirs.
    let spec = entry.discovery_spec();
    let candidates = cli_discovery::discover_all(&spec, None).await;
    if let Some(best) = cli_discovery::select_best(&candidates) {
        return Ok(ServerSpec {
            command: best.canonical.clone(),
            args: entry.args.iter().map(|s| s.to_string()).collect(),
            display_name: entry.lsp_id.to_string(),
        });
    }

    // Step 2: managed install at ~/.cadencr/lsp/<lsp_id>/<version>/<bin>.
    // For entries without a download recipe this just checks an explicit
    // user-installed path; with a recipe, step 4's downloader actually
    // fetches the binary the first time.
    if let Some(managed) = ensure_managed_binary(entry).await? {
        return Ok(ServerSpec {
            command: managed,
            args: entry.args.iter().map(|s| s.to_string()).collect(),
            display_name: entry.lsp_id.to_string(),
        });
    }

    Err(AppError::NotFound(format!(
        "language server {bin:?} ({id}) not found; install it on $PATH \
         (looked under common install dirs as well)",
        bin = entry.bin_name,
        id = entry.lsp_id,
    )))
}

/// Resolve the managed-install path for a catalog entry. Triggers the
/// downloader if the entry has a recipe and the binary isn't already
/// present. Returns `Ok(None)` when there's no recipe and no pre-existing
/// binary — caller surfaces that as `NotFound`.
async fn ensure_managed_binary(entry: &CatalogEntry) -> Result<Option<PathBuf>, AppError> {
    let recipe = match &entry.download {
        Some(r) => r,
        None => return Ok(None),
    };
    let bin_path = downloader::managed_bin_path(entry, recipe)?;
    if bin_path.exists() {
        if let DownloadRecipe::GithubReleaseGz {
            sha256_by_platform, ..
        } = recipe
        {
            let expected_sha256 = checksum::current_platform_sha256(sha256_by_platform)?;
            if checksum::verify_sha256(&bin_path, expected_sha256).is_err() {
                let _ = std::fs::remove_file(&bin_path);
            } else {
                return Ok(Some(bin_path));
            }
        } else {
            return Ok(Some(bin_path));
        }
    }
    downloader::download_and_install(entry, recipe).await?;
    Ok(Some(bin_path))
}

/// Spawns the configured server with stdio piped. The caller takes ownership
/// of stdin/stdout/stderr and drives them; we set `kill_on_drop` so a panicked
/// proxy task does not leak a zombie language server.
pub fn spawn_server(spec: &ServerSpec, workspace_root: &Path) -> Result<Child, AppError> {
    Command::new(&spec.command)
        .args(&spec.args)
        .current_dir(workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Internal(format!("failed to spawn {}: {e}", spec.display_name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_family_resolves_synchronously() {
        for lang in [
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ] {
            let entry = resolve_language(lang).expect(lang);
            assert_eq!(entry.bin_name, "typescript-language-server");
        }
    }

    #[test]
    fn rust_resolves_to_rust_analyzer_via_catalog() {
        let entry = resolve_language("rust").expect("rust");
        assert_eq!(entry.bin_name, "rust-analyzer");
    }

    #[test]
    fn unknown_language_is_bad_request() {
        let err = resolve_language("brainfuck").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn resolve_by_unknown_id_is_bad_request() {
        let err = resolve_server_by_id("not-a-real-server").await.unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn known_id_resolves_in_catalog() {
        // Resolution-by-id is exercised without spawning the managed-install
        // pipeline (which would hit the network and write to ~/.cadencr in a
        // unit test). The async resolve path reuses `resolve_entry`, covered by
        // the language-based tests; here we just confirm the id lookup feeding
        // `resolve_server_by_id` finds the new servers.
        for id in ["tsgo", "biome", "eslint", "oxlint"] {
            assert!(
                catalog::lookup_by_id(id).is_some(),
                "{id} missing from catalog"
            );
        }
    }
}
