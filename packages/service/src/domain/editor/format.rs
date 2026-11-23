//! `POST /api/editor/format` — run a project's configured formatter CLI on
//! buffer content and return the formatted text.
//!
//! The renderer owns the buffer, so we format *content* (sent on the
//! formatter's stdin) rather than the file on disk — no race with an unsaved
//! buffer, and the result is applied by the editor as a single edit. The
//! formatter binary is resolved through `cli-discovery` (same PATH-blindness
//! handling the LSP host relies on) and cached per formatter id; the recipe
//! comes from the provider-neutral `format_catalog`.

mod cache;
mod exec_error;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use utoipa::ToSchema;

use super::format_catalog;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;
use crate::shared::bounded_command::{capture_with_input, InputCapture};
use cache::{global_cache, FormatterBinaryCache};
use exec_error::{classify_failure, FormatExecError};

/// Cap formatter stdin payloads at 10 MiB to bound memory and IPC cost.
const MAX_FORMAT_INPUT_BYTES: usize = 10 * 1024 * 1024;
/// Cap formatted stdout at 16 MiB (allows expansion over max input).
const MAX_FORMAT_STDOUT_BYTES: usize = 16 * 1024 * 1024;
/// Cap formatter stderr at 256 KiB.
const MAX_FORMAT_STDERR_BYTES: usize = 256 * 1024;
/// Strictly below the frontend Axios 30s timeout so the server cleanly kills
/// hung formatters before the client disconnects.
const FORMAT_TIMEOUT: Duration = Duration::from_secs(15);

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

#[derive(Clone, Copy)]
struct FormatLimits {
    max_input_bytes: usize,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    timeout: Duration,
}

impl FormatLimits {
    const DEFAULT: Self = Self {
        max_input_bytes: MAX_FORMAT_INPUT_BYTES,
        max_stdout_bytes: MAX_FORMAT_STDOUT_BYTES,
        max_stderr_bytes: MAX_FORMAT_STDERR_BYTES,
        timeout: FORMAT_TIMEOUT,
    };
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
        (status = 400, description = "Unknown formatter, invalid path, oversized input, or the formatter rejected the content"),
        (status = 404, description = "Formatter binary not installed (FORMATTER_NOT_FOUND), or the project directory is gone (FORMATTER_CWD_NOT_FOUND)"),
        (status = 500, description = "The search for the formatter binary failed (FORMATTER_DISCOVERY_FAILED)"),
        (status = 502, description = "The formatter could not run or misbehaved: FORMATTER_INTERPRETER_NOT_FOUND, FORMATTER_SPAWN_FAILED, FORMATTER_INPUT_FAILED, FORMATTER_OUTPUT_TOO_LARGE, FORMATTER_INVALID_OUTPUT or FORMATTER_FAILED"),
        (status = 504, description = "The formatter timed out (FORMATTER_TIMEOUT)"),
    )
)]
pub async fn format_handler(
    State(state): State<AppState>,
    Json(body): Json<FormatRequest>,
) -> Result<Json<FormatResponse>, AppError> {
    let entry = format_catalog::lookup(&body.formatter)
        .ok_or_else(|| AppError::BadRequest(format!("unknown formatter {:?}", body.formatter)))?;
    validate_input_size(body.content.len(), MAX_FORMAT_INPUT_BYTES)?;

    // Resolve the feature/project root so the formatter runs with the right
    // working dir (picks up `.prettierrc`, `biome.json`, etc.).
    let project_root =
        resolve_feature_editor_root(&state.read_pool, body.project_id, body.feature_id).await?;
    let args = entry.build_args(&body.file_path);

    let formatted = format_with_cache(
        global_cache(),
        entry,
        &args,
        &project_root,
        body.content.as_bytes(),
        FormatLimits::DEFAULT,
        || discover_formatter_binary(entry),
    )
    .await?;
    Ok(Json(FormatResponse { content: formatted }))
}

async fn discover_formatter_binary(
    entry: &format_catalog::FormatterEntry,
) -> Result<Option<PathBuf>, AppError> {
    let spec = entry.discovery_spec();
    let candidates = cli_discovery::discover_all(&spec, None)
        .await
        .map_err(|error| {
            AppError::coded(
                StatusCode::INTERNAL_SERVER_ERROR,
                "FORMATTER_DISCOVERY_FAILED",
                format!(
                    "could not look for the {} formatter: {error}",
                    entry.bin_name
                ),
            )
        })?;
    Ok(cli_discovery::select_best(&candidates).map(|best| best.canonical.clone()))
}

/// Run the cached binary; when it vanished since it was found, look for it
/// again once.
async fn format_with_cache<F, Fut>(
    cache: &FormatterBinaryCache,
    entry: &format_catalog::FormatterEntry,
    args: &[String],
    cwd: &Path,
    content: &[u8],
    limits: FormatLimits,
    mut discover: F,
) -> Result<String, AppError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Option<PathBuf>, AppError>>,
{
    let command = cache.resolve_with(entry, &mut discover).await?;
    match run_formatter_exec(&command, args, cwd, content, entry.id, limits).await {
        Ok(formatted) => Ok(formatted),
        Err(FormatExecError::BinaryMissing(_)) => {
            cache.invalidate(entry.id).await;
            let refreshed = cache.resolve_with(entry, &mut discover).await?;
            run_formatter_exec(&refreshed, args, cwd, content, entry.id, limits)
                .await
                .map_err(|error| error.into_app_error(entry, &refreshed))
        }
        Err(other) => Err(other.into_app_error(entry, &command)),
    }
}

fn validate_input_size(len: usize, max_input_bytes: usize) -> Result<(), AppError> {
    if len > max_input_bytes {
        return Err(AppError::BadRequest(format!(
            "formatter input exceeds {} bytes size limit",
            max_input_bytes
        )));
    }
    Ok(())
}

/// Run the formatter as a filter under byte caps and a hard timeout (its
/// whole process group is killed on timeout, on failure, and when the request
/// is dropped) and return its stdout.
async fn run_formatter_exec(
    command: &Path,
    args: &[String],
    cwd: &Path,
    content: &[u8],
    formatter_id: &str,
    limits: FormatLimits,
) -> Result<String, FormatExecError> {
    validate_input_size(content.len(), limits.max_input_bytes).map_err(FormatExecError::App)?;

    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let input = InputCapture::builder()
        .timeout(limits.timeout)
        .stdin(content)
        .max_stdout_bytes(limits.max_stdout_bytes)
        .max_stderr_bytes(limits.max_stderr_bytes)
        .stdout_capacity(content.len())
        .build();
    let output = capture_with_input(cmd, input)
        .await
        .map_err(|error| classify_failure(error, command, cwd, formatter_id, limits))?;

    if !output.status.success() {
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        let detail = stderr_text.trim();
        let msg = if detail.is_empty() {
            format!("{formatter_id} exited with status {}", output.status)
        } else {
            format!("{formatter_id}: {detail}")
        };
        return Err(FormatExecError::App(AppError::BadRequest(msg)));
    }

    String::from_utf8(output.stdout).map_err(|error| {
        FormatExecError::App(AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_INVALID_OUTPUT",
            format!("{formatter_id} produced output that is not UTF-8 text: {error}"),
        ))
    })
}

fn format_timeout_label(timeout: Duration) -> String {
    if timeout >= Duration::from_secs(1) {
        format!("{}s", timeout.as_secs())
    } else {
        format!("{}ms", timeout.as_millis())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    fn prettier() -> &'static format_catalog::FormatterEntry {
        format_catalog::lookup("prettier").expect("prettier entry")
    }

    async fn run_formatter_with(
        command: &Path,
        args: &[String],
        cwd: &Path,
        content: &str,
        limits: FormatLimits,
    ) -> Result<String, AppError> {
        run_formatter_exec(command, args, cwd, content.as_bytes(), "fmt", limits)
            .await
            .map_err(|error| error.into_app_error(prettier(), command))
    }

    async fn run_formatter(
        command: &Path,
        args: &[String],
        content: &str,
    ) -> Result<String, AppError> {
        let cwd = std::env::temp_dir();
        run_formatter_with(command, args, &cwd, content, FormatLimits::DEFAULT).await
    }

    fn sh(script: &str) -> Vec<String> {
        vec!["-c".to_string(), script.to_string()]
    }

    fn code(error: &AppError) -> Option<(StatusCode, &'static str)> {
        match error {
            AppError::Coded { status, code, .. } => Some((*status, *code)),
            _ => None,
        }
    }

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
    async fn oversized_input_is_rejected_without_spawning() {
        let limits = FormatLimits {
            max_input_bytes: 16,
            ..FormatLimits::DEFAULT
        };
        let err = run_formatter_with(
            Path::new("/nonexistent/should-not-run"),
            &[],
            &std::env::temp_dir(),
            &"a".repeat(17),
            limits,
        )
        .await
        .expect_err("oversized input must fail");
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn run_formatter_passes_stdin_through_cat() {
        let out = run_formatter(Path::new("/bin/cat"), &[], "hello\n")
            .await
            .expect("cat should succeed");
        assert_eq!(out, "hello\n");
    }

    /// 256 KiB exceeds both macOS (16-64 KiB) and Linux (64 KiB) pipe buffers:
    /// sequential stdin write before stdout read would deadlock forever.
    #[tokio::test]
    async fn run_formatter_streams_256kib_without_pipe_deadlock() {
        let payload = "0123456789abcdef\n".repeat(16 * 1024);
        let out = run_formatter(Path::new("/bin/cat"), &[], &payload)
            .await
            .expect("256 KiB payload must not deadlock");
        assert_eq!(out, payload);
    }

    #[tokio::test]
    async fn run_formatter_surfaces_nonzero_exit() {
        let err = run_formatter(Path::new("/usr/bin/false"), &[], "x")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn run_formatter_handles_broken_pipe_and_surfaces_stderr() {
        let payload = "x".repeat(256 * 1024);
        let args = sh("echo 'syntax error on line 1' >&2; exit 2");
        let err = run_formatter(Path::new("/bin/sh"), &args, &payload)
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::BadRequest(ref msg) if msg.contains("syntax error on line 1")),
            "expected stderr detail, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn run_formatter_times_out_and_kills_child() {
        let limits = FormatLimits {
            timeout: Duration::from_millis(150),
            ..FormatLimits::DEFAULT
        };
        let started = Instant::now();
        let err = run_formatter_with(
            Path::new("/bin/sleep"),
            &["60".to_string()],
            &std::env::temp_dir(),
            "",
            limits,
        )
        .await
        .expect_err("sleep 60 must time out");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            code(&err),
            Some((StatusCode::GATEWAY_TIMEOUT, "FORMATTER_TIMEOUT")),
            "{err:?}"
        );
    }

    /// The shell may not have started its child, let alone written its pid,
    /// when a short timeout fires: retry with longer ones until it has, so
    /// the descendant is always checked instead of the pid file being read
    /// too early.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_formatter_timeout_kills_process_group_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let args = vec![
            "-c".to_string(),
            "sleep 30 & echo $! > \"$1\"; wait".to_string(),
            "format-pgid-test".to_string(),
            pid_file.to_string_lossy().to_string(),
        ];
        let mut timeouts = [300, 1_000, 3_000, 10_000].into_iter();
        let pid: libc::pid_t = loop {
            let timeout = timeouts
                .next()
                .expect("the shell never wrote its child's pid");
            let limits = FormatLimits {
                timeout: Duration::from_millis(timeout),
                ..FormatLimits::DEFAULT
            };
            let err = run_formatter_with(Path::new("/bin/sh"), &args, dir.path(), "", limits)
                .await
                .expect_err("hung shell launcher must time out");
            assert_eq!(
                code(&err),
                Some((StatusCode::GATEWAY_TIMEOUT, "FORMATTER_TIMEOUT"))
            );
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|pid| pid.trim().parse().ok())
            {
                break pid;
            }
        };
        assert!(
            crate::shared::test_processes::wait_until_gone(pid, Duration::from_secs(10)).await,
            "grandchild survived formatter timeout"
        );
    }

    /// The formatter misbehaved, the request did not: 502, not 400.
    #[tokio::test]
    async fn oversized_or_non_utf8_output_is_a_bad_gateway() {
        let limits = FormatLimits {
            max_stdout_bytes: 1024,
            ..FormatLimits::DEFAULT
        };
        let cwd = std::env::temp_dir();
        let err = run_formatter_with(Path::new("/bin/cat"), &[], &cwd, &"a".repeat(2048), limits)
            .await
            .expect_err("oversized stdout must fail");
        assert_eq!(
            code(&err),
            Some((StatusCode::BAD_GATEWAY, "FORMATTER_OUTPUT_TOO_LARGE"))
        );

        let err = run_formatter(Path::new("/bin/sh"), &sh("printf '\\377'"), "")
            .await
            .unwrap_err();
        assert_eq!(
            code(&err),
            Some((StatusCode::BAD_GATEWAY, "FORMATTER_INVALID_OUTPUT"))
        );
    }

    fn counting_discovery(
        calls: &Arc<AtomicUsize>,
        found: &Path,
    ) -> impl FnMut() -> std::future::Ready<Result<Option<PathBuf>, AppError>> {
        let calls = calls.clone();
        let found = found.to_path_buf();
        move || {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(Some(found.clone())))
        }
    }

    #[tokio::test]
    async fn binary_cache_reuses_entry_and_invalidates_on_not_found() {
        let cache = FormatterBinaryCache::default();
        let cwd = std::env::temp_dir();
        let calls = Arc::new(AtomicUsize::new(0));
        let missing = PathBuf::from("/nonexistent/cadencr-missing-formatter-bin");
        cache
            .insert(prettier().id, Some(missing), Instant::now())
            .await;

        for (content, expected_calls) in [("ok\n", 1), ("cached\n", 1)] {
            let out = format_with_cache(
                &cache,
                prettier(),
                &[],
                &cwd,
                content.as_bytes(),
                FormatLimits::DEFAULT,
                counting_discovery(&calls, Path::new("/bin/cat")),
            )
            .await
            .expect("a vanished binary is looked for again, then cached");
            assert_eq!(out, content);
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
        }
    }

    /// A script whose `#!` interpreter is missing also fails with ENOENT,
    /// but the binary is right there: looking for it again cannot help.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_interpreter_is_reported_without_rediscovery() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let shim = dir.path().join("prettier");
        std::fs::write(&shim, "#!/nonexistent/cadencr-node\n").unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cache = FormatterBinaryCache::default();
        cache
            .insert(prettier().id, Some(shim.clone()), Instant::now())
            .await;
        let calls = Arc::new(AtomicUsize::new(0));
        let err = format_with_cache(
            &cache,
            prettier(),
            &[],
            dir.path(),
            "x".as_bytes(),
            FormatLimits::DEFAULT,
            counting_discovery(&calls, &shim),
        )
        .await
        .unwrap_err();
        assert_eq!(
            code(&err),
            Some((StatusCode::BAD_GATEWAY, "FORMATTER_INTERPRETER_NOT_FOUND")),
            "{err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_deleted_project_directory_is_reported_without_rediscovery() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("deleted-worktree");
        let cache = FormatterBinaryCache::default();
        cache
            .insert(
                prettier().id,
                Some(PathBuf::from("/bin/cat")),
                Instant::now(),
            )
            .await;
        let calls = Arc::new(AtomicUsize::new(0));
        let err = format_with_cache(
            &cache,
            prettier(),
            &[],
            &gone,
            "x".as_bytes(),
            FormatLimits::DEFAULT,
            counting_discovery(&calls, Path::new("/bin/cat")),
        )
        .await
        .unwrap_err();
        assert_eq!(
            code(&err),
            Some((StatusCode::NOT_FOUND, "FORMATTER_CWD_NOT_FOUND")),
            "{err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_binary_still_missing_after_rediscovery_is_a_coded_not_found() {
        let cache = FormatterBinaryCache::default();
        let missing = Path::new("/nonexistent/cadencr-missing-formatter-bin");
        cache
            .insert(prettier().id, Some(missing.to_path_buf()), Instant::now())
            .await;
        let calls = Arc::new(AtomicUsize::new(0));
        let err = format_with_cache(
            &cache,
            prettier(),
            &[],
            &std::env::temp_dir(),
            "x".as_bytes(),
            FormatLimits::DEFAULT,
            counting_discovery(&calls, missing),
        )
        .await
        .unwrap_err();
        assert_eq!(
            code(&err),
            Some((StatusCode::NOT_FOUND, "FORMATTER_NOT_FOUND")),
            "{err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
