//! How one run ended: the record its Activity shows, and the revision it
//! held released.

use super::handshake::{self, FailureKind, Handshake, HandshakeFailure};
use super::history::{ExitRecord, History};
use super::process::Running;
use crate::domain::plugin_tabs::managed::storage::RevisionLease;

/// How long a process that exited is given for its stdout reader to settle
/// the handshake from the lines it wrote before exiting.
const LAST_LINES_GRACE: std::time::Duration = std::time::Duration::from_millis(250);

/// Release a run's revision lease, reclaiming the revision of a tab removed
/// while it ran; a failure is told in the Activity's log.
pub(super) async fn release(lease: RevisionLease, history: &History) {
    let released = tokio::task::spawn_blocking(move || lease.release())
        .await
        .map_err(|error| error.to_string())
        .and_then(|released| released.map_err(|error| error.to_string()));
    if let Err(error) = released {
        history.push_stderr(format!(
            "[cadencr] could not reclaim its removed tab's files: {error}"
        ));
    }
}

/// The record of a process that exited on its own. Before `ready` it is a
/// crash whatever its status (a protocol mismatch it wrote first also blocks
/// restarts): a backend exiting 0 at once would otherwise restart forever.
pub(super) async fn exited(
    status: std::io::Result<std::process::ExitStatus>,
    running: &Running,
    history: &History,
) -> ExitRecord {
    let mut exit = exit_record(status);
    handshake::settled_within(&running.handshake, LAST_LINES_GRACE).await;
    let current = running.handshake.borrow().clone();
    match current {
        Handshake::Ready => {}
        Handshake::Failed(failure) if failure.kind == FailureKind::ProtocolMismatch => {
            history.refuse(failure.message.clone());
            exit.reason = failure.message;
            exit.crashed = true;
        }
        Handshake::Failed(_) => exit.crashed = true,
        Handshake::Waiting => {
            // Waiting requests are told how it exited; its Activity, when.
            handshake::settle(
                &running.handshake,
                Handshake::Failed(HandshakeFailure::exited(&exit.reason)),
            );
            exit.reason = format!("{} before it was ready", exit.reason);
            exit.crashed = true;
        }
    }
    exit
}

fn exit_record(status: std::io::Result<std::process::ExitStatus>) -> ExitRecord {
    match status {
        Ok(status) if status.success() => ExitRecord {
            code: Some(0),
            reason: "exited on its own".into(),
            crashed: false,
        },
        Ok(status) => ExitRecord {
            code: status.code(),
            reason: match status.code() {
                Some(code) => format!("exited with status {code}"),
                None => "was killed by a signal".into(),
            },
            crashed: true,
        },
        Err(error) => ExitRecord {
            code: None,
            reason: format!("could not be waited for: {error}"),
            crashed: true,
        },
    }
}
