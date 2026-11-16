//! `exec.run` (`docs/CUSTOM_TABS.md` §4.6): run one of the tab's declared
//! `commands` in its conversation's folder.
//!
//! The tab names a program and its arguments; Cadencr runs it without a
//! shell, through the same direct-exec policy as managed providers (no
//! `CADENCR_*`/`VITE_*` variables, resource limits, the whole process tree
//! killed on timeout), and returns the bounded output. The program must be
//! listed in `tab.json` — consent was given to *that* list — and is resolved
//! on the user's `PATH`. Every request is recorded in the [`ActivityLog`].

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use cadencr_plugin_core::tab::TabManifest;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use utoipa::ToSchema;

use super::activity::{
    cut, ActivityLog, PluginTabExecOutcome, PluginTabExecRecord, MAX_RECORDED_PROGRAM_CHARS,
};
use super::principal::PluginPrincipal;
use crate::domain::agents::providers::installed::managed::process_policy::{
    capture_managed_command, managed_command, ManagedProcessPolicyError,
    ManagedProcessPolicyErrorCode, MANAGED_MAX_CAPTURE_BYTES,
};
use crate::domain::features::service::get_feature_cwd;
use crate::error::AppError;
use cli_discovery::find_on_path;

pub const MAX_ARGS: usize = 256;
pub const MAX_ARGS_BYTES: usize = 128 * 1024;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(120);
/// Commands one tab may have running at once.
pub const MAX_CONCURRENT: usize = 4;

/// `POST /api/plugin-tabs/self/exec`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct PluginExecRequest {
    /// Exactly as listed in the manifest's `commands[].program`.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 1 ms – 120 s; 30 s when omitted.
    pub timeout_ms: Option<u64>,
}

/// The finished command. A non-zero exit is a result, not an error.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginExecResult {
    /// `None` when the process was ended by a signal.
    pub exit_code: Option<i32>,
    pub success: bool,
    /// UTF-8, lossily decoded; each stream is at most 1 MiB.
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Run `request` for the tab behind `principal`, whose granted manifest is
/// `manifest`. Every outcome is recorded in `activity`.
pub async fn run(
    pool: &SqlitePool,
    activity: &ActivityLog,
    principal: &PluginPrincipal,
    manifest: &TabManifest,
    request: PluginExecRequest,
) -> Result<PluginExecResult, AppError> {
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let started = Instant::now();
    let outcome = execute(pool, principal, manifest, &request).await;
    let (kind, exit_code, error) = match &outcome {
        Ok(result) => (PluginTabExecOutcome::Exited, result.exit_code, None),
        Err(failure) => (failure.outcome, None, Some(failure.error.to_string())),
    };
    tracing::info!(
        plugin_id = principal.plugin_id,
        feature_id = principal.feature_id,
        program = %cut(&request.program, MAX_RECORDED_PROGRAM_CHARS),
        args = request.args.len(),
        outcome = ?kind,
        exit_code,
        "custom tab command"
    );
    activity.record(
        &principal.plugin_id,
        principal.feature_id,
        PluginTabExecRecord {
            program: request.program,
            args: request.args,
            started_at,
            duration_ms: elapsed_ms(started),
            outcome: kind,
            exit_code,
            error,
        },
    );
    outcome.map_err(|failure| failure.error)
}

struct Failure {
    outcome: PluginTabExecOutcome,
    error: AppError,
}

fn refused(error: AppError) -> Failure {
    Failure {
        outcome: PluginTabExecOutcome::Refused,
        error,
    }
}

async fn execute(
    pool: &SqlitePool,
    principal: &PluginPrincipal,
    manifest: &TabManifest,
    request: &PluginExecRequest,
) -> Result<PluginExecResult, Failure> {
    if manifest.command(&request.program).is_none() {
        return Err(refused(AppError::coded(
            StatusCode::FORBIDDEN,
            "PLUGIN_EXEC_DENIED",
            format!(
                "`{}` is not in this tab's `commands` in tab.json",
                cut(&request.program, MAX_RECORDED_PROGRAM_CHARS)
            ),
        )));
    }
    let timeout = check_request(request).map_err(refused)?;
    let _slot = acquire(&principal.plugin_id)?;
    let cwd = get_feature_cwd(pool, principal.feature_id)
        .await
        .map(PathBuf::from)
        .map_err(refused)?;
    let executable = find_on_path(&request.program).ok_or_else(|| {
        refused(AppError::coded(
            StatusCode::UNPROCESSABLE_ENTITY,
            "PLUGIN_EXEC_NOT_FOUND",
            format!("`{}` was not found on PATH", request.program),
        ))
    })?;
    let command = managed_command(&executable, &request.args, &BTreeMap::new(), &cwd)
        .map_err(|error| failed(&request.program, error))?;
    let started = Instant::now();
    let output = capture_managed_command(command, timeout)
        .await
        .map_err(|error| failed(&request.program, error))?;
    Ok(PluginExecResult {
        exit_code: output.status.code(),
        success: output.status.success(),
        stdout: text(output.stdout),
        stderr: text(output.stderr),
        duration_ms: elapsed_ms(started),
    })
}

/// The bounds a request must respect; its timeout when it does.
fn check_request(request: &PluginExecRequest) -> Result<Duration, AppError> {
    let bytes: usize = request.args.iter().map(String::len).sum();
    if request.args.len() > MAX_ARGS
        || bytes > MAX_ARGS_BYTES
        || request.args.iter().any(|arg| arg.contains('\0'))
    {
        return Err(AppError::BadRequest(format!(
            "at most {MAX_ARGS} arguments and {} KiB in total, without NUL",
            MAX_ARGS_BYTES / 1024
        )));
    }
    request_timeout(request.timeout_ms)
}

/// `timeout_ms` of an `exec.run` or `backend.request`: 1 ms – [`MAX_TIMEOUT`],
/// [`DEFAULT_TIMEOUT`] when omitted.
pub(super) fn request_timeout(timeout_ms: Option<u64>) -> Result<Duration, AppError> {
    let timeout = timeout_ms.map_or(DEFAULT_TIMEOUT, Duration::from_millis);
    if timeout.is_zero() || timeout > MAX_TIMEOUT {
        return Err(AppError::BadRequest(format!(
            "timeout_ms must be between 1 and {}",
            MAX_TIMEOUT.as_millis()
        )));
    }
    Ok(timeout)
}

/// The output as text, copied only when it is not valid UTF-8.
fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
}

fn failed(program: &str, error: ManagedProcessPolicyError) -> Failure {
    let (outcome, status, code, message) = match error.code {
        ManagedProcessPolicyErrorCode::ProcessTimedOut => (
            PluginTabExecOutcome::TimedOut,
            StatusCode::GATEWAY_TIMEOUT,
            "PLUGIN_EXEC_TIMEOUT",
            format!("`{program}` did not finish in time and was stopped"),
        ),
        ManagedProcessPolicyErrorCode::OutputTooLarge => (
            PluginTabExecOutcome::Failed,
            StatusCode::BAD_GATEWAY,
            "PLUGIN_EXEC_OUTPUT_TOO_LARGE",
            format!(
                "`{program}` wrote more than {} MiB and was stopped",
                MANAGED_MAX_CAPTURE_BYTES / (1024 * 1024)
            ),
        ),
        _ => (
            PluginTabExecOutcome::Failed,
            StatusCode::BAD_GATEWAY,
            "PLUGIN_EXEC_FAILED",
            format!("`{program}` could not run: {}", error.message),
        ),
    };
    Failure {
        outcome,
        error: AppError::coded(status, code, message),
    }
}

/// A slot among the tab's [`MAX_CONCURRENT`] commands, or 429 `PLUGIN_EXEC_BUSY`.
fn acquire(plugin_id: &str) -> Result<OwnedSemaphorePermit, Failure> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Semaphore>>>> = OnceLock::new();
    let semaphore = SLOTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(plugin_id.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT)))
        .clone();
    semaphore.try_acquire_owned().map_err(|_| {
        refused(AppError::coded(
            StatusCode::TOO_MANY_REQUESTS,
            "PLUGIN_EXEC_BUSY",
            format!("at most {MAX_CONCURRENT} commands at a time"),
        ))
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(args: Vec<String>, timeout_ms: Option<u64>) -> PluginExecRequest {
        PluginExecRequest {
            program: "git".into(),
            args,
            timeout_ms,
        }
    }

    fn code(failure: Failure) -> &'static str {
        match failure.error {
            AppError::Coded { code, .. } => code,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn requests_are_bounded() {
        assert_eq!(
            check_request(&request(vec![], None)).ok(),
            Some(DEFAULT_TIMEOUT)
        );
        assert_eq!(
            check_request(&request(vec!["log".into()], Some(500))).ok(),
            Some(Duration::from_millis(500))
        );
        for bad in [
            request(vec!["a\0b".into()], None),
            request(vec!["x".into(); MAX_ARGS + 1], None),
            request(vec!["x".repeat(MAX_ARGS_BYTES + 1)], None),
            request(vec![], Some(0)),
            request(vec![], Some(120_001)),
        ] {
            assert!(matches!(check_request(&bad), Err(AppError::BadRequest(_))));
        }
    }

    #[test]
    fn process_failures_map_to_stable_codes() {
        let error = |code| ManagedProcessPolicyError {
            code,
            message: "m".into(),
        };
        let timeout = failed("git", error(ManagedProcessPolicyErrorCode::ProcessTimedOut));
        assert_eq!(timeout.outcome, PluginTabExecOutcome::TimedOut);
        assert_eq!(code(timeout), "PLUGIN_EXEC_TIMEOUT");
        let large = failed("git", error(ManagedProcessPolicyErrorCode::OutputTooLarge));
        assert_eq!(code(large), "PLUGIN_EXEC_OUTPUT_TOO_LARGE");
        let spawn = failed(
            "git",
            error(ManagedProcessPolicyErrorCode::ProcessSpawnFailed),
        );
        assert_eq!(spawn.outcome, PluginTabExecOutcome::Failed);
        assert_eq!(code(spawn), "PLUGIN_EXEC_FAILED");
    }
}
