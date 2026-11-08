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

/// How long a cancelled run waits for the output it has not read yet. Once its
/// process group is dead, only a process that left the group (a daemon) can
/// still hold the pipes open, and the run must not wait on it.
const CANCEL_DRAIN: Duration = Duration::from_secs(1);

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
    let (exit_code, note, drain) = match wait {
        WaitResult::Exited(code) => (code, None, None),
        WaitResult::Cancelled => {
            let note = match cancel_child(&mut child).await {
                Ok(()) => "\n[cadencr] Command stopped (Ctrl-C).".to_string(),
                Err(error) => format!(
                    "\n[cadencr] Command stopped (Ctrl-C), but some of its processes could not be killed: {error}"
                ),
            };
            (USER_CANCEL_EXIT_CODE, Some(note), Some(CANCEL_DRAIN))
        }
    };

    // Stop the flusher and drain the readers so the final write is complete.
    stop.notify_one();
    let _ = flusher.await;
    let drain_deadline = drain.map(|limit| tokio::time::Instant::now() + limit);
    for reader in [stdout_reader, stderr_reader].into_iter().flatten() {
        drain_reader(reader, drain_deadline).await;
    }

    let stdout = stdout_buf.lock().await.clone();
    let mut stderr = stderr_buf.lock().await.clone();
    if let Some(note) = note {
        stderr.push_str(&note);
    }
    finalize(&ctx, Some(exit_code), &stdout, &stderr).await;
}

/// The exit code a user-cancelled run records (128 + SIGINT).
const USER_CANCEL_EXIT_CODE: i64 = 130;

/// Tear down a user-cancelled child and reap it. The child leads its own
/// process group (see [`spawn_shell`]): a Ctrl-C (SIGINT) reaches the login
/// shell and every descendant, [`CANCEL_GRACE`] lets well-behaved ones clean
/// up, then SIGKILL ends whatever is left of the group, a background job the
/// shell started with SIGINT ignored included.
async fn cancel_child(child: &mut Child) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        crate::shared::process_group::interrupt_process_group(child, libc::SIGINT, CANCEL_GRACE)
            .await
            .map(drop)
    }
    #[cfg(not(unix))]
    {
        child.kill().await
    }
}

/// Wait for a reader to collect what is left in its pipe: without limit when
/// the command exited, until `deadline` after a cancel (then the reader stops
/// and the output read so far is kept).
async fn drain_reader(mut reader: JoinHandle<()>, deadline: Option<tokio::time::Instant>) {
    let Some(deadline) = deadline else {
        if let Err(error) = reader.await {
            warn!(%error, "custom action output reader failed");
        }
        return;
    };
    match tokio::time::timeout_at(deadline, &mut reader).await {
        Ok(Err(error)) => warn!(%error, "custom action output reader failed"),
        Ok(Ok(())) => {}
        Err(_) => reader.abort(),
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
    // every descendant at once (see `cancel_child`).
    #[cfg(unix)]
    crate::shared::process_group::lead_new_process_group(&mut cmd);
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

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::{run_and_finalize, Prepared, RunContext, USER_CANCEL_EXIT_CODE};
    use crate::domain::custom_actions::models::{Scope, TriggeredBy};
    use crate::domain::custom_actions::repository::{self, test_support};
    use crate::domain::custom_actions::run_registry::CustomActionRunRegistry;

    #[tokio::test]
    async fn cancelling_kills_a_background_job_and_finishes_without_waiting_for_it() {
        let (pool, project_id, feature_id) = test_support::pool_with_project_and_feature().await;
        let action_id = repository::insert(
            &pool,
            "bg",
            "-",
            None,
            Scope::Project,
            Some(project_id),
            false,
        )
        .await
        .unwrap();
        let run_id = repository::insert_run(&pool, action_id, feature_id, TriggeredBy::Manual)
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("background.pid");
        let runs = Arc::new(CustomActionRunRegistry::new());
        let ctx = RunContext {
            pool: pool.clone(),
            runs: runs.clone(),
            events: tokio::sync::broadcast::channel(16).0,
            action_id,
            feature_id,
            run_id,
        };
        // The background `sleep` starts with SIGINT ignored and keeps the
        // output pipes open: a Ctrl-C alone neither ends it nor the run.
        let prepared = Prepared {
            command: format!("sleep 120 & echo $! > '{}'; sleep 120", pid_file.display()),
            cwd: directory.path().display().to_string(),
        };
        let run = tokio::spawn(run_and_finalize(ctx, prepared));

        let mut background = None;
        // The login shell sources the user's profile first: give it time.
        for _ in 0..1000 {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<libc::pid_t>().ok())
            {
                background = Some(pid);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let background = background.expect("the action started its background job");
        assert!(runs.cancel(run_id).await, "the run is cancellable");

        tokio::time::timeout(Duration::from_secs(15), run)
            .await
            .expect("the cancelled run finishes without waiting for its job")
            .unwrap();
        let mut alive = true;
        for _ in 0..100 {
            alive = unsafe { libc::kill(background, 0) } == 0;
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if alive {
            unsafe { libc::kill(background, libc::SIGKILL) };
        }
        assert!(!alive, "the background job survived the cancel");

        let recorded = repository::list_runs(&pool, action_id, feature_id, 1)
            .await
            .unwrap();
        assert_eq!(recorded[0].exit_code, Some(USER_CANCEL_EXIT_CODE));
        assert!(recorded[0].ended_at.is_some());
        assert!(
            recorded[0].stderr.contains("Command stopped (Ctrl-C)."),
            "{}",
            recorded[0].stderr
        );
    }
}
