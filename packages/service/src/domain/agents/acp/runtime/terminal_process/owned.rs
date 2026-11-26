//! Command ownership for service-hosted ACP terminals. The command can
//! finish while a worker still belongs to it, so publish its exit without
//! releasing its reserved session ID until the worker is gone or stopped.

use std::time::Duration;

use cli_discovery::{observe_child_exit, ChildSession};
use tokio::process::Child;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::supervisor::drain_pumps;
use super::{ExitOutcome, KillReply, KILL_GRACE};
use crate::domain::agents::acp::runtime::terminal_io::{exit_signal, ExitInfo};
use crate::domain::agents::process_sessions::pinned_session_has_work;
use crate::shared::discard::SendIgnoreClosed;

pub(super) async fn supervise(
    mut child: Child,
    owner: ChildSession,
    mut kill_rx: mpsc::UnboundedReceiver<KillReply>,
    pumps: Vec<JoinHandle<()>>,
    exit_tx: watch::Sender<Option<ExitOutcome>>,
) {
    let pid = child.id().expect("spawned terminal owns a direct child");
    let exit = tokio::select! {
        status = observe_child_exit(&mut child, Some(&owner)) => status,
        reply = kill_rx.recv() => {
            let status = owner.terminate(&mut child, KILL_GRACE).await;
            if let Some(reply) = reply { reply.send_ignore_closed(as_result(&status)); }
            drain_pumps(pumps).await;
            exit_tx.send_replace(Some(exit_info(status)));
            return;
        }
    };
    drain_pumps(pumps).await;
    let observed = match exit {
        Ok(observed) => observed,
        Err(error) => {
            exit_tx.send_replace(Some(Err(error.to_string())));
            return;
        }
    };
    exit_tx.send_replace(Some(exit_info(Ok(observed.status()))));
    let reply = loop {
        if matches!(pinned_session_has_work(pid).await, Ok(false)) {
            break None;
        }
        tokio::select! {
            reply = kill_rx.recv() => break reply,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {},
        }
    };
    let status = observed.reap(&mut child, Some(&owner)).await;
    if let Some(reply) = reply {
        reply.send_ignore_closed(as_result(&status));
    }
}

fn as_result(status: &std::io::Result<std::process::ExitStatus>) -> Result<(), String> {
    status.as_ref().map(|_| ()).map_err(ToString::to_string)
}

fn exit_info(status: std::io::Result<std::process::ExitStatus>) -> ExitOutcome {
    status
        .map(|status| ExitInfo {
            exit_code: status.code(),
            signal: exit_signal(&status),
        })
        .map_err(|error| error.to_string())
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use crate::shared::process_table::stop_pinned_session;
    use cli_discovery::ChildSessionObserver;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    struct VerifyDrain;

    impl ChildSessionObserver for VerifyDrain {
        fn started(&self, _: u32) {}

        fn before_reap(&self, pid: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async move { stop_pinned_session(pid).await.unwrap() })
        }
    }

    #[tokio::test]
    async fn natural_exit_keeps_owned_work_until_the_terminal_is_killed() {
        let owner = ChildSession::new(Arc::new(VerifyDrain));
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "sleep 15 & exit 7"]).kill_on_drop(true);
        let child = owner.spawn(command).await.unwrap();
        let pid = child.id().unwrap();
        let process = super::super::TerminalProcess::start(child, Vec::new(), Some(owner));

        let exit = tokio::time::timeout(Duration::from_secs(3), process.exit_waiter().wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit["exitCode"], 7);
        assert!(pinned_session_has_work(pid).await.unwrap());
        process.kill().await.unwrap();
        assert!(!pinned_session_has_work(pid).await.unwrap());
    }
}
