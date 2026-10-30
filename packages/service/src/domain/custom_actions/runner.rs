use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;
use tracing::warn;

use super::events::{notify_run, CustomActionEventKind, CustomActionEventSender};
use super::models::TriggeredBy;
use super::repository;
use super::run_registry::CustomActionRunRegistry;
use super::service;
use crate::app_state::AppState;
use crate::error::AppError;

/// How often a still-running command's captured output is persisted so the UI
/// can show it incrementally instead of waiting for the process to exit.
const FLUSH_INTERVAL: Duration = Duration::from_millis(750);

/// Grace period after a Ctrl-C (SIGINT) before escalating to SIGKILL, so a
/// well-behaved command can clean up but a stuck one still dies promptly.
const CANCEL_GRACE: Duration = Duration::from_secs(3);

/// How a run's wait ended, deciding how the child is torn down.
enum WaitResult {
    /// The command exited on its own with this code.
    Exited(i64),
    /// The user requested cancellation (Ctrl-C).
    Cancelled,
}

/// Where a run's progress is persisted and announced.
#[derive(Clone)]
struct RunContext {
    pool: SqlitePool,
    runs: Arc<CustomActionRunRegistry>,
    events: CustomActionEventSender,
    action_id: i64,
    feature_id: i64,
    run_id: i64,
}

impl RunContext {
    fn new(state: &AppState, action_id: i64, feature_id: i64, run_id: i64) -> Self {
        Self {
            pool: state.write_pool.clone(),
            runs: state.custom_action_runs.clone(),
            events: state.custom_action_events_tx.clone(),
            action_id,
            feature_id,
            run_id,
        }
    }

    fn notify(&self, kind: CustomActionEventKind) {
        notify_run(
            &self.events,
            kind,
            self.action_id,
            self.feature_id,
            self.run_id,
        );
    }
}

/// Resolved command + working directory for an `(action, feature)` pair.
struct Prepared {
    command: String,
    cwd: String,
}

/// Resolve the action, its working directory and the interpolated command.
///
/// Fails fast with a user-facing error (unknown action, missing worktree,
/// missing `${VAR}` values) so callers can surface it before creating a run
/// row — these are the errors the manual `run` endpoint returns synchronously.
async fn prepare(state: &AppState, action_id: i64, feature_id: i64) -> Result<Prepared, AppError> {
    let action = repository::get(&state.read_pool, action_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Custom action {action_id} not found")))?;

    let cwd = crate::domain::git::service::resolve_feature_working_path(state, feature_id)
        .await?
        .ok_or_else(|| {
            AppError::BadRequest(
                "Feature has no working directory yet — set up a worktree or open a project."
                    .into(),
            )
        })?;

    let vars = repository::list_variables(&state.read_pool, action_id, feature_id).await?;
    let values: HashMap<String, String> = vars.into_iter().map(|v| (v.var_name, v.value)).collect();
    let command = service::interpolate(&action.command, &values)?;
    Ok(Prepared { command, cwd })
}

/// Resolve an action's `${VAR}`-interpolated command and working directory
/// without running it. Used by the "run in terminal" path, which executes the
/// command in a client-side PTY rather than a backgrounded server process.
pub async fn resolve(
    state: &AppState,
    action_id: i64,
    feature_id: i64,
) -> Result<(String, String), AppError> {
    let prepared = prepare(state, action_id, feature_id).await?;
    Ok((prepared.command, prepared.cwd))
}

/// Start an asynchronous run: create the run row, kick the command off in the
/// background and return `run_id` immediately.
///
/// Output and exit code are streamed into `custom_action_runs` as they arrive,
/// so the request returns instantly and the run survives the triggering UI
/// component unmounting. Setup errors (missing worktree/variables) still
/// surface synchronously via [`prepare`].
pub async fn start(
    state: &AppState,
    action_id: i64,
    feature_id: i64,
    triggered_by: TriggeredBy,
) -> Result<i64, AppError> {
    let prepared = prepare(state, action_id, feature_id).await?;
    let run_id =
        repository::insert_run(&state.write_pool, action_id, feature_id, triggered_by).await?;
    let ctx = RunContext::new(state, action_id, feature_id, run_id);
    ctx.notify(CustomActionEventKind::RunStarted);
    tokio::spawn(run_and_finalize(ctx, prepared));
    Ok(run_id)
}

/// Spawn the shell, stream stdout/stderr into the run row while it runs, and
/// finalize with the exit code once it exits or is cancelled.
async fn run_and_finalize(ctx: RunContext, prepared: Prepared) {
    let mut child = match spawn_shell(&prepared.command, &prepared.cwd) {
        Ok(c) => c,
        Err(e) => {
            finalize(
                &ctx,
                Some(-1),
                "",
                &format!("Failed to start login shell: {e}"),
            )
            .await;
            return;
        }
    };

    let stdout_buf = Arc::new(Mutex::new(String::new()));
    let stderr_buf = Arc::new(Mutex::new(String::new()));
    let stdout_reader = child
        .stdout
        .take()
        .map(|s| spawn_reader(s, stdout_buf.clone()));
    let stderr_reader = child
        .stderr
        .take()
        .map(|s| spawn_reader(s, stderr_buf.clone()));

    let stop = Arc::new(Notify::new());
    let flusher = spawn_flusher(
        ctx.clone(),
        stdout_buf.clone(),
        stderr_buf.clone(),
        stop.clone(),
    );

    // Register a cancel signal so a `cancel` request can interrupt this run.
    // There is no timeout: custom actions are user-defined and may run
    // indefinitely (e.g. dev servers), so a run only ends when the command
    // exits or the user cancels it.
    let cancel = ctx.runs.register(ctx.run_id, ctx.feature_id).await;
    let wait = tokio::select! {
        res = child.wait() => match res {
            Ok(status) => WaitResult::Exited(status.code().map(i64::from).unwrap_or(-1)),
            Err(_) => WaitResult::Exited(-1),
        },
        _ = cancel.notified() => WaitResult::Cancelled,
    };
    ctx.runs.unregister(ctx.run_id).await;

    // The select! futures are dropped above, so `child` is free to borrow again.
    let (exit_code, note) = match wait {
        WaitResult::Exited(code) => (code, None),
        WaitResult::Cancelled => {
            let code = cancel_child(&mut child).await;
            (
                code,
                Some("\n[cadencr] Command stopped (Ctrl-C).".to_string()),
            )
        }
    };

    // Stop the flusher and drain the readers so the final write is complete.
    stop.notify_one();
    let _ = flusher.await;
    if let Some(h) = stdout_reader {
        let _ = h.await;
    }
    if let Some(h) = stderr_reader {
        let _ = h.await;
    }

    let stdout = stdout_buf.lock().await.clone();
    let mut stderr = stderr_buf.lock().await.clone();
    if let Some(note) = note {
        stderr.push_str(&note);
    }
    finalize(&ctx, Some(exit_code), &stdout, &stderr).await;
}

/// Tear down a user-cancelled child and reap it. Sends a Ctrl-C (SIGINT) first
/// and escalates to SIGKILL only if the command ignores it within
/// [`CANCEL_GRACE`], so a well-behaved command can clean up. Returns the exit
/// code to record (130 = 128 + SIGINT for a user cancel).
async fn cancel_child(child: &mut Child) -> i64 {
    #[cfg(unix)]
    {
        signal_group(child, libc::SIGINT);
        if tokio::time::timeout(CANCEL_GRACE, child.wait())
            .await
            .is_err()
        {
            signal_group(child, libc::SIGKILL);
            let _ = child.wait().await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    130
}

/// Send `sig` to the child's whole process group (negative pid). The child
/// leads its own group (see `process_group(0)` in [`spawn_shell`]), so the
/// signal reaches the login shell *and* every descendant it spawned — matching
/// what Ctrl-C does to a terminal's foreground job. Best-effort: a dead group
/// just yields `ESRCH`.
#[cfg(unix)]
fn signal_group(child: &Child, sig: i32) {
    if let Some(pid) = child.id() {
        // Safety: a bare `kill(2)` syscall with no shared-state requirements.
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }
}

/// Spawn the shared user-shell command in `cwd`.
///
/// The shared helper uses a login shell and inherits the process environment
/// that service startup already hydrated from the user's shell.
fn spawn_shell(command: &str, cwd: &str) -> std::io::Result<Child> {
    let mut cmd = crate::shared::user_shell::command(command, std::path::Path::new(cwd));
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Run in its own process group so cancellation can signal the shell and
    // every descendant at once (see `signal_group`).
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.spawn()
}

/// Drain an async reader into a shared buffer, appending chunks as they arrive.
fn spawn_reader<R>(mut reader: R, buf: Arc<Mutex<String>>) -> JoinHandle<()>
where
    R: AsyncReadExt + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut chunk = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf
                    .lock()
                    .await
                    .push_str(&String::from_utf8_lossy(&chunk[..n])),
            }
        }
    })
}

/// Periodically persist the captured streams until signalled to stop.
fn spawn_flusher(
    ctx: RunContext,
    stdout_buf: Arc<Mutex<String>>,
    stderr_buf: Arc<Mutex<String>>,
    stop: Arc<Notify>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        ticker.tick().await; // eat the immediate first tick
        let mut last_len = 0usize;
        loop {
            tokio::select! {
                _ = stop.notified() => break,
                _ = ticker.tick() => {
                    last_len = flush_partial(&ctx, &stdout_buf, &stderr_buf, last_len).await;
                }
            }
        }
    })
}

/// Snapshot the buffers and write them to the run row without marking it done.
///
/// Skips the write when nothing new arrived since `last_len` — the buffers only
/// ever grow (readers append), so an unchanged combined length means an idle
/// process and we avoid hammering the shared write pool every tick. Returns the
/// combined length now persisted for the next tick's comparison.
async fn flush_partial(
    ctx: &RunContext,
    stdout_buf: &Arc<Mutex<String>>,
    stderr_buf: &Arc<Mutex<String>>,
    last_len: usize,
) -> usize {
    let stdout = stdout_buf.lock().await.clone();
    let stderr = stderr_buf.lock().await.clone();
    let len = stdout.len() + stderr.len();
    if len == last_len {
        return len;
    }
    match repository::update_run_output(&ctx.pool, ctx.run_id, &stdout, &stderr).await {
        Ok(()) => ctx.notify(CustomActionEventKind::RunOutput),
        Err(e) => {
            warn!(error = %e, run_id = ctx.run_id, "failed to persist partial custom action output")
        }
    }
    len
}

/// Mark the run finished. Logs (rather than propagates) failures because this
/// runs in a detached background task with no caller to receive the error.
async fn finalize(ctx: &RunContext, exit_code: Option<i64>, stdout: &str, stderr: &str) {
    if let Err(e) = repository::finalize_run(&ctx.pool, ctx.run_id, exit_code, stdout, stderr).await
    {
        warn!(error = %e, run_id = ctx.run_id, "failed to finalize custom action run");
    }
    // Announced even when the write failed: clients re-fetch and show the
    // row's actual state rather than waiting on a run that will never update.
    ctx.notify(CustomActionEventKind::RunFinished);
}
