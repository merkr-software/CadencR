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

use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWriteExt};
use tokio::process::Command;
use utoipa::ToSchema;

use super::format_catalog;
use crate::app_state::AppState;
use crate::domain::projects::service::resolve_feature_editor_root;
use crate::error::AppError;
use crate::shared::bounded_command::read_stream_capped;
use crate::shared::discard::cleanup;
#[cfg(unix)]
use crate::shared::process_group::{lead_new_process_group, signal_process_group};
use cache::{global_cache, FormatterBinaryCache};

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

enum FormatExecError {
    NotFound(std::io::Error),
    App(AppError),
}

impl FormatExecError {
    fn into_app_error(self, formatter_id: &str) -> AppError {
        match self {
            Self::NotFound(error) => {
                AppError::internal(format!("failed to spawn {formatter_id}: {error}"))
            }
            Self::App(error) => error,
        }
    }
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
        (status = 400, description = "Unknown formatter, invalid path, or oversized input"),
        (status = 404, description = "Formatter binary not installed"),
    )
)]
pub async fn format_handler(
    State(state): State<AppState>,
    Json(body): Json<FormatRequest>,
) -> Result<Json<FormatResponse>, AppError> {
    let entry = format_catalog::lookup(&body.formatter)
        .ok_or_else(|| AppError::BadRequest(format!("unknown formatter {:?}", body.formatter)))?;
    validate_input_size(&body.content, MAX_FORMAT_INPUT_BYTES)?;

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
        &body.content,
        FormatLimits::DEFAULT,
        || discover_formatter_binary(entry),
    )
    .await?;
    Ok(Json(FormatResponse { content: formatted }))
}

async fn discover_formatter_binary(entry: &format_catalog::FormatterEntry) -> Option<PathBuf> {
    let spec = entry.discovery_spec();
    let candidates = cli_discovery::discover_all(&spec, None).await;
    cli_discovery::select_best(&candidates).map(|best| best.canonical.clone())
}

async fn format_with_cache<F, Fut>(
    cache: &FormatterBinaryCache,
    entry: &format_catalog::FormatterEntry,
    args: &[String],
    cwd: &Path,
    content: &str,
    limits: FormatLimits,
    mut discover: F,
) -> Result<String, AppError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<PathBuf>>,
{
    let command = cache.resolve_with(entry, &mut discover).await?;
    match run_formatter_exec(&command, args, cwd, content, entry.id, limits).await {
        Ok(formatted) => Ok(formatted),
        Err(FormatExecError::NotFound(_)) => {
            cache.invalidate(entry.id).await;
            let refreshed = cache.resolve_with(entry, &mut discover).await?;
            run_formatter_exec(&refreshed, args, cwd, content, entry.id, limits)
                .await
                .map_err(|error| error.into_app_error(entry.id))
        }
        Err(other) => Err(other.into_app_error(entry.id)),
    }
}

fn validate_input_size(content: &str, max_input_bytes: usize) -> Result<(), AppError> {
    if content.len() > max_input_bytes {
        return Err(AppError::BadRequest(format!(
            "formatter input exceeds {} bytes size limit",
            max_input_bytes
        )));
    }
    Ok(())
}

fn spawn_formatter_child(
    command: &Path,
    args: &[String],
    cwd: &Path,
    formatter_id: &str,
) -> Result<tokio::process::Child, FormatExecError> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    lead_new_process_group(&mut cmd);

    cmd.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            FormatExecError::NotFound(error)
        } else {
            FormatExecError::App(AppError::internal(format!(
                "failed to spawn {formatter_id}: {error}"
            )))
        }
    })
}

/// Spawn the formatter in its own process group (on Unix) with `kill_on_drop`,
/// drive stdin/stdout/stderr concurrently under byte caps and a hard timeout,
/// and return stdout.
async fn run_formatter_exec(
    command: &Path,
    args: &[String],
    cwd: &Path,
    content: &str,
    formatter_id: &str,
    limits: FormatLimits,
) -> Result<String, FormatExecError> {
    validate_input_size(content, limits.max_input_bytes).map_err(FormatExecError::App)?;

    let mut child = spawn_formatter_child(command, args, cwd, formatter_id)?;
    // `wait` clears the child's id when a launcher exits before its descendants.
    let process_group = child.id();

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| FormatExecError::App(AppError::internal("formatter stdin unavailable")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| FormatExecError::App(AppError::internal("formatter stdout unavailable")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FormatExecError::App(AppError::internal("formatter stderr unavailable")))?;

    let io_and_wait = async {
        let ((), stdout_bytes, stderr_bytes) = tokio::try_join!(
            write_stdin_allow_broken_pipe(stdin, content.as_bytes(), formatter_id),
            read_formatter_stream(
                stdout,
                limits.max_stdout_bytes,
                content.len(),
                formatter_id,
                "stdout",
            ),
            read_formatter_stream(stderr, limits.max_stderr_bytes, 0, formatter_id, "stderr"),
        )?;
        let status = child
            .wait()
            .await
            .map_err(|e| AppError::internal(format!("{formatter_id} did not complete: {e}")))?;
        Ok::<_, AppError>((status, stdout_bytes, stderr_bytes))
    };

    let (status, stdout_bytes, stderr_bytes) =
        match tokio::time::timeout(limits.timeout, io_and_wait).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => {
                kill_formatter_child(&mut child, process_group, "kill failed formatter").await;
                return Err(FormatExecError::App(error));
            }
            Err(_) => {
                kill_formatter_child(&mut child, process_group, "kill timed-out formatter").await;
                return Err(FormatExecError::App(AppError::coded(
                    StatusCode::GATEWAY_TIMEOUT,
                    "FORMATTER_TIMEOUT",
                    format!(
                        "{formatter_id} timed out after {}",
                        format_timeout_label(limits.timeout)
                    ),
                )));
            }
        };

    if !status.success() {
        let stderr_text = String::from_utf8_lossy(&stderr_bytes);
        let detail = stderr_text.trim();
        let msg = if detail.is_empty() {
            format!("{formatter_id} exited with status {status}")
        } else {
            format!("{formatter_id}: {detail}")
        };
        return Err(FormatExecError::App(AppError::BadRequest(msg)));
    }

    String::from_utf8(stdout_bytes).map_err(|error| {
        FormatExecError::App(AppError::internal(format!(
            "{formatter_id} produced invalid UTF-8: {error}"
        )))
    })
}

async fn kill_formatter_child(
    child: &mut tokio::process::Child,
    process_group: Option<u32>,
    reason: &'static str,
) {
    #[cfg(unix)]
    if let Some(pid) = process_group {
        if let Err(kill_error) = signal_process_group(pid, libc::SIGKILL) {
            tracing::warn!(%kill_error, pid, "failed to kill formatter process group ({reason})");
        }
    }
    #[cfg(not(unix))]
    let _ = process_group;
    cleanup(child.kill().await, reason);
}

async fn write_stdin_allow_broken_pipe(
    mut stdin: tokio::process::ChildStdin,
    bytes: &[u8],
    formatter_id: &str,
) -> Result<(), AppError> {
    if let Err(error) = stdin.write_all(bytes).await {
        if error.kind() != ErrorKind::BrokenPipe {
            return Err(AppError::internal(format!(
                "failed writing to {formatter_id}: {error}"
            )));
        }
    }
    if let Err(error) = stdin.shutdown().await {
        if error.kind() != ErrorKind::BrokenPipe {
            return Err(AppError::internal(format!(
                "failed closing {formatter_id} stdin: {error}"
            )));
        }
    }
    drop(stdin);
    Ok(())
}

async fn read_formatter_stream(
    reader: impl AsyncRead + Unpin,
    max_bytes: usize,
    initial_capacity: usize,
    formatter_id: &str,
    stream: &'static str,
) -> Result<Vec<u8>, AppError> {
    read_stream_capped(reader, max_bytes, initial_capacity)
        .await
        .map_err(|error| {
            if error.is_output_exceeded() {
                AppError::BadRequest(format!(
                    "{formatter_id} {stream} exceeded {max_bytes} bytes size limit"
                ))
            } else {
                AppError::internal(format!("failed reading {formatter_id} {stream}: {error}"))
            }
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

    async fn run_formatter(
        command: &Path,
        args: &[String],
        cwd: &Path,
        content: &str,
        formatter_id: &str,
    ) -> Result<String, AppError> {
        run_formatter_exec(
            command,
            args,
            cwd,
            content,
            formatter_id,
            FormatLimits::DEFAULT,
        )
        .await
        .map_err(|error| error.into_app_error(formatter_id))
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
        let cwd = std::env::temp_dir();
        let limits = FormatLimits {
            max_input_bytes: 16,
            ..FormatLimits::DEFAULT
        };
        let err = run_formatter_exec(
            Path::new("/nonexistent/should-not-run"),
            &[],
            &cwd,
            &"a".repeat(17),
            "test-fmt",
            limits,
        )
        .await
        .expect_err("oversized input must fail");
        assert!(matches!(err, FormatExecError::App(AppError::BadRequest(_))));
    }

    #[tokio::test]
    async fn run_formatter_passes_stdin_through_cat() {
        let cwd = std::env::temp_dir();
        let out = run_formatter(Path::new("/bin/cat"), &[], &cwd, "hello\n", "cat")
            .await
            .expect("cat should succeed");
        assert_eq!(out, "hello\n");
    }

    /// 256 KiB exceeds both macOS (16-64 KiB) and Linux (64 KiB) pipe buffers:
    /// sequential stdin write before stdout read would deadlock forever.
    #[tokio::test]
    async fn run_formatter_streams_256kib_without_pipe_deadlock() {
        let cwd = std::env::temp_dir();
        let payload = "0123456789abcdef\n".repeat(16 * 1024);
        assert!(payload.len() >= 256 * 1024);

        let out = run_formatter(Path::new("/bin/cat"), &[], &cwd, &payload, "cat")
            .await
            .expect("256 KiB payload must not deadlock");
        assert_eq!(out.len(), payload.len());
        assert_eq!(out, payload);
    }

    #[tokio::test]
    async fn run_formatter_surfaces_nonzero_exit() {
        let cwd = std::env::temp_dir();
        let err = run_formatter(Path::new("/usr/bin/false"), &[], &cwd, "x", "false")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[tokio::test]
    async fn run_formatter_handles_broken_pipe_and_surfaces_stderr() {
        let cwd = std::env::temp_dir();
        let payload = "x".repeat(256 * 1024);
        let args = vec![
            "-c".to_string(),
            "echo 'syntax error on line 1' >&2; exit 2".to_string(),
        ];
        let err = run_formatter(Path::new("/bin/sh"), &args, &cwd, &payload, "sh")
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::BadRequest(ref msg) if msg.contains("syntax error on line 1")),
            "expected stderr detail, got: {err:?}"
        );
    }

    #[tokio::test]
    async fn run_formatter_times_out_and_kills_child() {
        let cwd = std::env::temp_dir();
        let limits = FormatLimits {
            timeout: Duration::from_millis(150),
            ..FormatLimits::DEFAULT
        };
        let started = Instant::now();
        let err = run_formatter_exec(
            Path::new("/bin/sleep"),
            &["60".to_string()],
            &cwd,
            "",
            "sleep",
            limits,
        )
        .await
        .expect_err("sleep 60 must time out");

        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timeout took too long: {:?}",
            started.elapsed()
        );
        assert!(
            matches!(
                err,
                FormatExecError::App(AppError::Coded {
                    status: StatusCode::GATEWAY_TIMEOUT,
                    code: "FORMATTER_TIMEOUT",
                    ..
                })
            ),
            "unexpected error: {:?}",
            err.into_app_error("sleep")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_formatter_timeout_kills_process_group_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let limits = FormatLimits {
            timeout: Duration::from_millis(300),
            ..FormatLimits::DEFAULT
        };
        let args = vec![
            "-c".to_string(),
            "sleep 30 & echo $! > \"$1\"; wait".to_string(),
            "format-pgid-test".to_string(),
            pid_file.to_string_lossy().to_string(),
        ];
        let err = run_formatter_exec(Path::new("/bin/sh"), &args, dir.path(), "", "sh", limits)
            .await
            .expect_err("hung shell launcher must time out");
        assert!(matches!(
            err,
            FormatExecError::App(AppError::Coded {
                status: StatusCode::GATEWAY_TIMEOUT,
                code: "FORMATTER_TIMEOUT",
                ..
            })
        ));

        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut alive = true;
        for _ in 0..40 {
            alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if alive {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(!alive, "grandchild survived formatter timeout");
    }

    #[tokio::test]
    async fn run_formatter_rejects_oversized_stdout() {
        let cwd = std::env::temp_dir();
        let limits = FormatLimits {
            max_stdout_bytes: 1024,
            ..FormatLimits::DEFAULT
        };
        let payload = "a".repeat(2048);
        let err = run_formatter_exec(Path::new("/bin/cat"), &[], &cwd, &payload, "cat", limits)
            .await
            .expect_err("oversized stdout must fail");
        assert!(
            matches!(err, FormatExecError::App(AppError::BadRequest(ref msg)) if msg.contains("stdout exceeded")),
            "unexpected error"
        );
    }

    #[tokio::test]
    async fn binary_cache_reuses_entry_and_invalidates_on_not_found() {
        let cache = FormatterBinaryCache::default();
        let entry = format_catalog::lookup("prettier").expect("prettier entry");
        let cwd = std::env::temp_dir();
        let discover_calls = Arc::new(AtomicUsize::new(0));

        // Seed cache with a stale path that no longer exists on disk.
        let missing = PathBuf::from("/nonexistent/cadencr-missing-formatter-bin");
        cache.insert(entry.id, Some(missing), Instant::now()).await;

        let calls = discover_calls.clone();
        let first = format_with_cache(
            &cache,
            entry,
            &[],
            &cwd,
            "ok\n",
            FormatLimits::DEFAULT,
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Some(PathBuf::from("/bin/cat"))
                }
            },
        )
        .await
        .expect("should invalidate stale cache and retry with /bin/cat");
        assert_eq!(first, "ok\n");
        assert_eq!(discover_calls.load(Ordering::SeqCst), 1);

        // Second call hits the freshly cached `/bin/cat` without rediscovering.
        let calls = discover_calls.clone();
        let second = format_with_cache(
            &cache,
            entry,
            &[],
            &cwd,
            "cached\n",
            FormatLimits::DEFAULT,
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Some(PathBuf::from("/bin/cat"))
                }
            },
        )
        .await
        .expect("cached binary should run without rediscovery");
        assert_eq!(second, "cached\n");
        assert_eq!(discover_calls.load(Ordering::SeqCst), 1);
    }
}
