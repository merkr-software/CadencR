//! What a failed formatter run tells the user: each failure gets its own
//! status and stable code instead of a masked 500.

use std::io::ErrorKind;
use std::path::Path;

use axum::http::StatusCode;

use super::super::format_catalog::FormatterEntry;
use super::cache::formatter_not_found;
use super::{format_timeout_label, FormatLimits};
use crate::error::AppError;
use crate::shared::bounded_command::{BoundedCommandError, OutputStream};

pub(super) enum FormatExecError {
    /// The binary is gone from where it was found: worth looking again.
    BinaryMissing(BoundedCommandError),
    App(AppError),
}

impl FormatExecError {
    /// `command` is the binary that was run.
    pub(super) fn into_app_error(self, entry: &FormatterEntry, command: &Path) -> AppError {
        match self {
            Self::BinaryMissing(error) => {
                formatter_not_found(entry, Some(format!("{}: {error}", command.display())))
            }
            Self::App(error) => error,
        }
    }
}

/// Sort a failed run by what the user can do about it.
pub(super) fn classify_failure(
    error: BoundedCommandError,
    command: &Path,
    cwd: &Path,
    formatter_id: &str,
    limits: FormatLimits,
) -> FormatExecError {
    if let Some(kind) = error.spawn_error_kind() {
        return spawn_failure(kind, error, command, cwd, formatter_id);
    }
    let app = if error.is_timed_out() {
        AppError::coded(
            StatusCode::GATEWAY_TIMEOUT,
            "FORMATTER_TIMEOUT",
            format!(
                "{formatter_id} timed out after {}",
                format_timeout_label(limits.timeout)
            ),
        )
    } else if let Some(stream) = error.exceeded_stream() {
        let (name, limit) = match stream {
            OutputStream::Stdout => ("output", limits.max_stdout_bytes),
            OutputStream::Stderr => ("error output", limits.max_stderr_bytes),
        };
        AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_OUTPUT_TOO_LARGE",
            format!("{formatter_id} {name} exceeded the {limit} bytes size limit"),
        )
    } else if error.is_stdin_failure() {
        AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_INPUT_FAILED",
            format!("could not send the document to {formatter_id}: {error}"),
        )
    } else {
        AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_FAILED",
            format!("{formatter_id} failed: {error}"),
        )
    };
    FormatExecError::App(app)
}

/// `ENOENT` from a spawn names any missing piece: the binary, the working
/// directory, or the interpreter a script's `#!` line (or a binary's loader)
/// names. Only a missing binary is worth looking for again.
fn spawn_failure(
    kind: ErrorKind,
    error: BoundedCommandError,
    command: &Path,
    cwd: &Path,
    formatter_id: &str,
) -> FormatExecError {
    if kind != ErrorKind::NotFound {
        return FormatExecError::App(AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_SPAWN_FAILED",
            format!("{formatter_id} at {} {error}", command.display()),
        ));
    }
    if !cwd.is_dir() {
        return FormatExecError::App(AppError::coded(
            StatusCode::NOT_FOUND,
            "FORMATTER_CWD_NOT_FOUND",
            format!(
                "cannot run {formatter_id}: the project directory {} no longer exists",
                cwd.display()
            ),
        ));
    }
    match std::fs::metadata(command) {
        Err(missing) if missing.kind() == ErrorKind::NotFound => {
            FormatExecError::BinaryMissing(error)
        }
        _ => FormatExecError::App(AppError::coded(
            StatusCode::BAD_GATEWAY,
            "FORMATTER_INTERPRETER_NOT_FOUND",
            format!(
                "{formatter_id} at {} could not start: the interpreter it needs (its `#!` line, e.g. node) was not found",
                command.display()
            ),
        )),
    }
}
