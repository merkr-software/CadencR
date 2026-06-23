//! `POST /api/editor/format` — run a project's configured formatter CLI on
//! buffer content and return the formatted text.
//!
//! The renderer owns the buffer, so we format *content* (sent on the
//! formatter's stdin) rather than the file on disk — no race with an unsaved
//! buffer, and the result is applied by the editor as a single edit. The
//! formatter binary is resolved through `cli-discovery` (same PATH-blindness
//! handling the LSP host relies on); the recipe comes from the provider-neutral
//! `format_catalog`.

use std::io::ErrorKind;
use std::process::Stdio;

use axum::extract::{Json, State};
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use utoipa::ToSchema;

use super::format_catalog;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;

#[derive(Debug, Deserialize, ToSchema)]
pub struct FormatRequest {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    /// Path (relative to the feature/project root) of the buffer being
    /// formatted; passed to the formatter so it can infer the parser.
    pub file_path: String,
    /// Current buffer content to format. Sent on the formatter's stdin.
    pub content: String,
    /// Formatter id from `editor_formatter` (e.g. `"prettier"`). Never `"off"`
    /// — the renderer skips the request when formatting is disabled.
    pub formatter: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FormatResponse {
    /// The formatted document. Identical to the input when already formatted.
    pub content: String,
}

pub fn format_router() -> Router<AppState> {
    Router::new().route("/api/editor/format", post(format_handler))
}

#[utoipa::path(
    post,
    path = "/api/editor/format",
    request_body = FormatRequest,
    responses(
        (status = 200, body = FormatResponse),
        (status = 400, description = "Unknown formatter or invalid path"),
        (status = 404, description = "Formatter binary not installed"),
    )
)]
pub async fn format_handler(
    State(state): State<AppState>,
    Json(body): Json<FormatRequest>,
) -> Result<Json<FormatResponse>, AppError> {
    let entry = format_catalog::lookup(&body.formatter)
        .ok_or_else(|| AppError::BadRequest(format!("unknown formatter {:?}", body.formatter)))?;

    // Resolve the feature/project root so the formatter runs with the right
    // working dir (picks up `.prettierrc`, `biome.json`, etc.).
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;

    let command = resolve_formatter_binary(entry).await?;
    let args = entry.build_args(&body.file_path);
    let formatted = run_formatter(&command, &args, &project_root, &body.content, entry.id).await?;
    Ok(Json(FormatResponse { content: formatted }))
}

/// Find the formatter binary on disk, failing with a useful install hint.
async fn resolve_formatter_binary(
    entry: &format_catalog::FormatterEntry,
) -> Result<std::path::PathBuf, AppError> {
    let spec = entry.discovery_spec();
    let candidates = cli_discovery::discover_all(&spec, None).await;
    cli_discovery::select_best(&candidates)
        .map(|best| best.canonical.clone())
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "formatter {bin:?} not found; install it on $PATH to enable {id} formatting",
                bin = entry.bin_name,
                id = entry.id,
            ))
        })
}

/// Spawn the formatter, write `content` to its stdin, and return its stdout.
/// A non-zero exit surfaces stderr verbatim so the user sees the real parse /
/// config error instead of a generic failure.
async fn run_formatter(
    command: &std::path::Path,
    args: &[String],
    cwd: &std::path::Path,
    content: &str,
    formatter_id: &str,
) -> Result<String, AppError> {
    let mut child = Command::new(command)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Internal(format!("failed to spawn {formatter_id}: {e}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Internal("formatter stdin unavailable".into()))?;
    if let Err(error) = stdin.write_all(content.as_bytes()).await {
        if error.kind() != ErrorKind::BrokenPipe {
            return Err(AppError::Internal(format!(
                "failed writing to {formatter_id}: {error}"
            )));
        }
    }
    drop(stdin); // close stdin so the formatter sees EOF

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| AppError::Internal(format!("{formatter_id} did not complete: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let msg = if detail.is_empty() {
            format!("{formatter_id} exited with status {}", output.status)
        } else {
            format!("{formatter_id}: {detail}")
        };
        return Err(AppError::BadRequest(msg));
    }

    String::from_utf8(output.stdout)
        .map_err(|e| AppError::Internal(format!("{formatter_id} produced invalid UTF-8: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_formatter_is_bad_request() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("pool");
        let state = AppState::with_pool(pool);
        let err = format_handler(
            State(state),
            Json(FormatRequest {
                project_id: 1,
                feature_id: None,
                file_path: "a.ts".into(),
                content: "const x=1".into(),
                formatter: "nope".into(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn run_formatter_passes_stdin_through_cat() {
        // `cat` is the identity formatter: stdin -> stdout, exit 0. Proves the
        // spawn/stdin/stdout plumbing without depending on a real formatter.
        let cwd = std::env::temp_dir();
        let out = run_formatter(
            std::path::Path::new("/bin/cat"),
            &[],
            &cwd,
            "hello\n",
            "cat",
        )
        .await
        .expect("cat should succeed");
        assert_eq!(out, "hello\n");
    }

    #[tokio::test]
    async fn run_formatter_surfaces_nonzero_exit() {
        // `false` exits 1 with no stdout/stderr.
        let cwd = std::env::temp_dir();
        let err = run_formatter(
            std::path::Path::new("/usr/bin/false"),
            &[],
            &cwd,
            "x",
            "false",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }
}
