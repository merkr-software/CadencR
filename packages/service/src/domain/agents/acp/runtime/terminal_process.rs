//! Supervisor task that owns one ACP terminal's `Child`.
//!
//! The child is never moved out by a waiter: a dedicated task awaits its exit
//! and serves kill requests at the same time, so `terminal/kill` and
//! `terminal/release` act even while a `terminal/wait_for_exit` is pending,
//! and any number of waiters observe the same published exit status.

use serde_json::{json, Value};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{AbortHandle, JoinHandle};

use super::terminal_io::{exit_signal, ExitInfo};

type ExitOutcome = Result<ExitInfo, String>;
type KillReply = oneshot::Sender<Result<(), String>>;

pub(super) struct TerminalProcess {
    kill_tx: mpsc::UnboundedSender<KillReply>,
    exit_rx: watch::Receiver<Option<ExitOutcome>>,
    pump_aborts: Vec<AbortHandle>,
    /// `None` once released: the supervisor is left to reap the killed child.
    supervisor: Option<JoinHandle<()>>,
}

/// Pending `terminal/wait_for_exit`, detached from the registry lock so the
/// event loop can await it off the dispatch path.
pub(super) struct TerminalExitWaiter(watch::Receiver<Option<ExitOutcome>>);

impl TerminalProcess {
    /// `pumps` drain the child's stdout/stderr; the exit status is published
    /// only after they finish so `terminal/output` is complete by then.
    pub(super) fn start(child: Child, pumps: Vec<JoinHandle<()>>) -> Self {
        let (kill_tx, kill_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = watch::channel(None);
        let pump_aborts = pumps.iter().map(JoinHandle::abort_handle).collect();
        let supervisor = tokio::spawn(supervise(child, kill_rx, pumps, exit_tx));
        Self {
            kill_tx,
            exit_rx,
            pump_aborts,
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

    /// Kill the command if it is still running. Killing an exited command is
    /// a successful no-op.
    pub(super) async fn kill(&self) -> Result<(), String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        if self.kill_tx.send(reply_tx).is_err() {
            return Ok(()); // Supervisor already observed the exit.
        }
        // A dropped reply means the child exited before the request was read.
        reply_rx.await.unwrap_or(Ok(()))
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
        // (`kill_on_drop`) and the runtime reaps it.
        if let Some(supervisor) = self.supervisor.take() {
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
    mut kill_rx: mpsc::UnboundedReceiver<KillReply>,
    pumps: Vec<JoinHandle<()>>,
    exit_tx: watch::Sender<Option<ExitOutcome>>,
) {
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            Some(reply) = kill_rx.recv() => {
                let result = child.start_kill().map_err(|error| error.to_string());
                // The requester may have gone away (request aborted).
                let _ = reply.send(result);
            }
        }
    };
    // Pending kill requests resolve as no-ops once the child has exited.
    drop(kill_rx);
    for pump in pumps {
        if let Err(error) = pump.await {
            if error.is_panic() {
                tracing::warn!(%error, "ACP terminal output pump panicked");
            }
        }
    }
    let outcome = status
        .map(|status| ExitInfo {
            exit_code: status.code(),
            signal: exit_signal(&status),
        })
        .map_err(|error| error.to_string());
    exit_tx.send_replace(Some(outcome));
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::process::Command;
    use tokio::sync::Mutex;

    use super::TerminalProcess;
    use crate::domain::agents::acp::runtime::terminal_io::{spawn_pumps, TerminalOutput};

    fn start(script: &str) -> TerminalProcess {
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn test terminal");
        let output = Arc::new(Mutex::new(TerminalOutput::new(1024)));
        let pumps = spawn_pumps(child.stdout.take(), child.stderr.take(), output);
        TerminalProcess::start(child, pumps)
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
        assert_eq!(exit["signal"], libc::SIGKILL);
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
            assert_eq!(exit["signal"], libc::SIGKILL);
        }
    }

    #[tokio::test]
    async fn exit_is_published_without_a_waiter_and_kill_after_exit_is_a_no_op() {
        let process = start("exit 3");
        let exit = within(process.exit_waiter().wait()).await.unwrap();
        assert_eq!(exit["exitCode"], 3);
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
