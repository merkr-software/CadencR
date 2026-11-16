//! Supervisor task that owns one ACP terminal's `Child`.
//!
//! The child is never moved out by a waiter: a dedicated task awaits its exit
//! and serves kill requests at the same time, so `terminal/kill` and
//! `terminal/release` act even while a `terminal/wait_for_exit` is pending,
//! and any number of waiters observe the same published exit status.
//!
//! A kill stops the command's whole process group: SIGTERM first, then, once
//! `KILL_GRACE` passes, SIGKILL for whatever is left (the leader included).
//! Output capture after the exit is bounded by `PUMP_DRAIN_TIMEOUT`, so a
//! descendant that keeps the pipes open cannot hold the exit status back. A
//! natural exit kills nothing: what the command left running (a server started
//! with `&`) lives on until a kill, a release, the session closing or the
//! service shutting down.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::{sleep_until, timeout, Instant};

use super::terminal_group::TerminalGroup;
use super::terminal_io::{exit_signal, ExitInfo};

pub(super) const KILL_GRACE: Duration = Duration::from_secs(2);
const PUMP_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

type ExitOutcome = Result<ExitInfo, String>;
type KillReply = oneshot::Sender<Result<(), String>>;

pub(super) struct TerminalProcess {
    kill_tx: mpsc::UnboundedSender<KillReply>,
    exit_rx: watch::Receiver<Option<ExitOutcome>>,
    pump_aborts: Vec<AbortHandle>,
    group: TerminalGroup,
    /// `None` once released: the supervisor is left to reap the killed child.
    supervisor: Option<JoinHandle<()>>,
}

/// Pending `terminal/wait_for_exit`, detached from the registry lock so the
/// event loop can await it off the dispatch path.
pub(super) struct TerminalExitWaiter(watch::Receiver<Option<ExitOutcome>>);

impl TerminalProcess {
    /// `pumps` drain the child's stdout/stderr; the exit status is published
    /// only after they finish (or `PUMP_DRAIN_TIMEOUT` passes) so
    /// `terminal/output` is complete by then. The child must have been spawned
    /// after `terminal_group::isolate`.
    pub(super) fn start(child: Child, pumps: Vec<JoinHandle<()>>) -> Self {
        let (kill_tx, kill_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(None);
        let pump_aborts = pumps.iter().map(JoinHandle::abort_handle).collect();
        let group = TerminalGroup::of(&child);
        let supervisor = tokio::spawn(supervise(child, group, kill_rx, pumps, exit_tx));
        Self {
            kill_tx,
            exit_rx,
            pump_aborts,
            group,
            supervisor: Some(supervisor),
        }
    }

    pub(super) fn exit_info(&self) -> Option<ExitInfo> {
        match self.exit_rx.borrow().as_ref() {
            Some(Ok(exit)) => Some(exit.clone()),
            _ => None,
        }
    }

    pub(super) fn exit_waiter(&self) -> TerminalExitWaiter {
        TerminalExitWaiter(self.exit_rx.clone())
    }

    pub(super) fn group(&self) -> TerminalGroup {
        self.group
    }

    /// Kill the command's process group: the running command and everything
    /// it started, or, once the command exited, whatever it left running.
    pub(super) async fn kill(&self) -> Result<(), String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self.kill_tx.send(reply_tx).is_ok() {
            if let Ok(killed) = reply_rx.await {
                return killed;
            }
        }
        // The supervisor already observed the exit (a dropped reply means the
        // child exited before the request was read).
        self.group
            .stop_after_exit(KILL_GRACE)
            .map_err(|error| error.to_string())
    }

    /// Kill, stop capturing output, and let the supervisor reap the child in
    /// the background so pending waiters still receive the exit status.
    pub(super) async fn release(mut self) -> Result<(), String> {
        let killed = self.kill().await;
        for pump in &self.pump_aborts {
            pump.abort();
        }
        self.supervisor.take();
        killed
    }
}

impl Drop for TerminalProcess {
    fn drop(&mut self) {
        // Registry dropped with the session: dropping the child kills it
        // (`kill_on_drop`) and the runtime reaps it; its group, including what
        // an exited command left running, goes with it. A released process
        // already stopped its group.
        if let Some(supervisor) = self.supervisor.take() {
            self.group.kill_on_drop();
            supervisor.abort();
        }
        for pump in &self.pump_aborts {
            pump.abort();
        }
    }
}

impl TerminalExitWaiter {
    pub(super) async fn wait(mut self) -> Result<Value, (i64, String)> {
        let outcome = self
            .0
            .wait_for(Option::is_some)
            .await
            .map_err(|_| {
                (
                    -32000,
                    "terminal/wait_for_exit: terminal was dropped before it exited".to_string(),
                )
            })?
            .clone();
        match outcome {
            Some(Ok(exit)) => Ok(json!({ "exitCode": exit.exit_code, "signal": exit.signal })),
            Some(Err(message)) => Err((-32000, format!("terminal/wait_for_exit: {message}"))),
            None => unreachable!("wait_for(Option::is_some) returned None"),
        }
    }
}

async fn supervise(
    mut child: Child,
    group: TerminalGroup,
    mut kill_rx: mpsc::UnboundedReceiver<KillReply>,
    pumps: Vec<JoinHandle<()>>,
    exit_tx: watch::Sender<Option<ExitOutcome>>,
) {
    let mut kill_requested = false;
    let mut escalate_at: Option<Instant> = None;
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            Some(reply) = kill_rx.recv() => {
                let result = group
                    .terminate(&mut child)
                    .or_else(|error| exited_meanwhile(&mut child, error));
                if result.is_ok() && !kill_requested {
                    kill_requested = true;
                    escalate_at = Some(Instant::now() + KILL_GRACE);
                }
                // The requester may have gone away (request aborted).
                let _ = reply.send(result);
            }
            () = sleep_until(escalate_at.unwrap_or_else(Instant::now)), if escalate_at.is_some() => {
                escalate_at = None;
                let killed = group
                    .kill(&mut child)
                    .or_else(|error| exited_meanwhile(&mut child, error));
                if let Err(error) = killed {
                    tracing::warn!(%error, "failed to SIGKILL an ACP terminal's process group");
                }
            }
        }
    };
    // Pending kill requests resolve as no-ops once the child has exited.
    drop(kill_rx);
    if kill_requested {
        // The grace covers the whole group: a shell that dies on SIGTERM at
        // once must not cut its children's cleanup short.
        group
            .wait_until_empty(escalate_at.unwrap_or_else(Instant::now))
            .await;
        if let Err(error) = group.kill_remaining().await {
            tracing::warn!(%error, "failed to kill an ACP terminal's remaining processes");
        }
    }
    drain_pumps(pumps).await;
    if !kill_requested {
        // A natural exit leaves the descendants running: the group stays
        // tracked while it has members, for an explicit stop to end them.
        group.forget_if_empty();
    }
    let outcome = status
        .map(|status| ExitInfo {
            exit_code: status.code(),
            signal: exit_signal(&status),
        })
        .map_err(|error| error.to_string());
    exit_tx.send_replace(Some(outcome));
}

/// macOS refuses to signal a group whose only member is the unreaped leader;
/// a command that exited in the meantime needs no kill.
fn exited_meanwhile(child: &mut Child, error: std::io::Error) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        _ => Err(error.to_string()),
    }
}

/// Let the pumps capture the output still buffered in the pipes, but stop
/// waiting (and reading) for a descendant that keeps them open after the
/// command exited. The descendant itself keeps running.
async fn drain_pumps(mut pumps: Vec<JoinHandle<()>>) {
    let drained = timeout(PUMP_DRAIN_TIMEOUT, async {
        for pump in &mut pumps {
            if let Err(error) = pump.await {
                if error.is_panic() {
                    tracing::warn!(%error, "ACP terminal output pump panicked");
                }
            }
        }
    })
    .await;
    if drained.is_err() {
        tracing::warn!(
            "ACP terminal output stayed open after the command exited; stopping capture"
        );
        for pump in &pumps {
            pump.abort();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::process::Command;
    use tokio::sync::Mutex;

    use super::TerminalProcess;
    use crate::domain::agents::acp::runtime::terminal_group::isolate;
    use crate::domain::agents::acp::runtime::terminal_io::{spawn_pumps, TerminalOutput};

    fn start(script: &str) -> TerminalProcess {
        start_capturing(script).0
    }

    fn start_capturing(script: &str) -> (TerminalProcess, Arc<Mutex<TerminalOutput>>) {
        let mut command = Command::new("/bin/sh");
        isolate(&mut command);
        let mut child = command
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn test terminal");
        let output = Arc::new(Mutex::new(TerminalOutput::new(1024)));
        let pumps = spawn_pumps(
            child.stdout.take(),
            child.stderr.take(),
            Arc::clone(&output),
        );
        (TerminalProcess::start(child, pumps), output)
    }

    /// The descendant is reparented to init once the shell is gone, which
    /// reaps it, so signal 0 failing means it is dead.
    fn alive(pid: libc::pid_t) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn read_pid(output: &Mutex<TerminalOutput>) -> libc::pid_t {
        for _ in 0..200 {
            let (text, _) = output.lock().await.snapshot();
            if let Some(pid) = text
                .lines()
                .next()
                .and_then(|line| line.trim().parse().ok())
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the terminal never printed its descendant's pid");
    }

    async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("terminal operation must settle")
    }

    #[tokio::test]
    async fn kill_reaches_a_command_while_wait_for_exit_is_pending() {
        // Regression: wait_for_exit used to move the Child out of the entry,
        // turning kill into a silent no-op and the wait into a hang.
        let process = start("exec sleep 30");
        let waiter = tokio::spawn(process.exit_waiter().wait());
        tokio::task::yield_now().await;
        within(process.kill()).await.expect("kill succeeds");
        let exit = within(waiter).await.unwrap().expect("exit status");
        assert_eq!(exit["signal"], libc::SIGTERM);
        assert!(exit["exitCode"].is_null());
        assert!(process.exit_info().is_some());
    }

    #[tokio::test]
    async fn release_kills_and_still_resolves_pending_waiters() {
        let process = start("exec sleep 30");
        let first = tokio::spawn(process.exit_waiter().wait());
        let second = tokio::spawn(process.exit_waiter().wait());
        within(process.release()).await.expect("release succeeds");
        for waiter in [first, second] {
            let exit = within(waiter).await.unwrap().expect("exit status");
            assert_eq!(exit["signal"], libc::SIGTERM);
        }
    }

    #[tokio::test]
    async fn kill_reaches_a_descendant_that_keeps_the_pipes_open() {
        // The shell backgrounds a grandchild that ignores SIGTERM and inherits
        // stdout/stderr, then waits: killing only the shell left the
        // grandchild holding the pipes, so the exit status never arrived.
        let (process, output) = start_capturing("trap '' TERM; sleep 30 & echo $!; wait");
        let descendant = read_pid(&output).await;
        assert!(alive(descendant));
        let waiter = tokio::spawn(process.exit_waiter().wait());
        within(process.kill()).await.expect("kill succeeds");
        within(waiter).await.unwrap().expect("exit status");
        for _ in 0..100 {
            if !alive(descendant) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the descendant outlived the terminal kill");
    }

    #[tokio::test]
    async fn kill_gives_descendants_the_grace_period_after_the_shell_dies() {
        // The shell dies on SIGTERM at once; its child traps SIGTERM to clean
        // up first. Killing the rest of the group as soon as the shell was
        // reaped cut that cleanup short.
        let marker = std::env::temp_dir().join(format!(
            "cadencr-terminal-grace-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        let script = format!(
            "(trap 'sleep 0.3; echo cleaned > \"{}\"; exit 0' TERM; \
             while :; do sleep 0.05; done) & echo $!; wait",
            marker.display()
        );
        let (process, output) = start_capturing(&script);
        let descendant = read_pid(&output).await;
        let waiter = tokio::spawn(process.exit_waiter().wait());
        within(process.kill()).await.expect("kill succeeds");
        within(waiter).await.unwrap().expect("exit status");
        let cleaned = std::fs::read_to_string(&marker);
        let _ = std::fs::remove_file(&marker);
        assert_eq!(
            cleaned.expect("the descendant finished its cleanup").trim(),
            "cleaned"
        );
        assert!(!alive(descendant));
    }

    #[tokio::test]
    async fn a_descendant_survives_the_command_and_dies_on_release() {
        // The command exits at once and leaves a background descendant (a dev
        // server started with `&`) holding the output pipes. The exit status
        // still arrives, bounded by the pump drain timeout, and the descendant
        // keeps running until the terminal is released.
        let (process, output) = start_capturing("sleep 30 & echo $!; exit 4");
        let descendant = read_pid(&output).await;
        let exit = within(process.exit_waiter().wait()).await.unwrap();
        assert_eq!(exit["exitCode"], 4);
        assert!(output
            .lock()
            .await
            .snapshot()
            .0
            .starts_with(&descendant.to_string()));
        assert!(alive(descendant), "a natural exit kills nothing");
        assert!(process.group().is_tracked());

        within(process.release()).await.expect("release succeeds");
        for _ in 0..150 {
            if !alive(descendant) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the descendant outlived the terminal release");
    }

    #[tokio::test]
    async fn kill_after_the_exit_stops_what_the_command_left_running() {
        let (process, output) = start_capturing("sleep 30 & echo $!; exit 0");
        let descendant = read_pid(&output).await;
        within(process.exit_waiter().wait()).await.unwrap();
        assert!(alive(descendant));
        within(process.kill()).await.expect("kill succeeds");
        // The group is forgotten once the background escalation sees it empty.
        for _ in 0..150 {
            if !alive(descendant) && !process.group().is_tracked() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the descendant outlived terminal/kill, or its group stayed tracked");
    }

    #[tokio::test]
    async fn exit_is_published_without_a_waiter_and_kill_after_exit_is_a_no_op() {
        let process = start("exit 3");
        let exit = within(process.exit_waiter().wait()).await.unwrap();
        assert_eq!(exit["exitCode"], 3);
        assert!(
            !process.group().is_tracked(),
            "an empty group is forgotten at the exit"
        );
        assert_eq!(process.exit_info().unwrap().exit_code, Some(3));
        within(process.kill())
            .await
            .expect("killing an exited command is fine");
    }

    #[tokio::test]
    async fn dropping_the_process_kills_the_command() {
        let process = start("exec sleep 30");
        let waiter = process.exit_waiter();
        drop(process);
        let error = within(waiter.wait()).await.expect_err("dropped terminal");
        assert_eq!(error.0, -32000);
    }
}
