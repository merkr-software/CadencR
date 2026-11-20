//! The task that owns the `Child`: it awaits the exit, serves kill requests
//! meanwhile (SIGTERM, then SIGKILL after `KILL_GRACE`), drains the output
//! pumps and publishes the exit status.

use crate::shared::discard::SendIgnoreClosed;
use std::time::Duration;

use tokio::process::Child;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{sleep_until, timeout, Instant};

use super::{ExitOutcome, KillReply, KILL_GRACE};
use crate::domain::agents::acp::runtime::terminal_group::TerminalGroup;
use crate::domain::agents::acp::runtime::terminal_io::{exit_signal, ExitInfo};

const PUMP_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) async fn supervise(
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
                reply.send_ignore_closed(result);
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
