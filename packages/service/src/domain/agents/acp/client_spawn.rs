//! Official ACP SDK connection setup for [`AcpClient`].

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use agent_client_protocol::{ByteStreams, Client};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Child;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::domain::agents::acp::client::{AcpClient, AcpSpawnOptions};
use crate::domain::agents::acp::client_dispatch::{EventDispatchHandler, ServerResponders};
use crate::domain::agents::acp::error::AcpError;
use crate::domain::agents::acp::event_hub::AcpEventHub;
use crate::domain::agents::acp::process_tree::ProcessTreeControl;
use crate::domain::agents::acp::types::{AcpClientInfo, AcpEvent};

mod stderr;

use stderr::spawn_stderr_reader;

const DEFAULT_MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
/// After the agent process exits, how long its stdout may stay open (e.g. an
/// orphaned grandchild inherited the pipe) before in-flight requests are
/// failed anyway. Long enough for the reader to drain frames the agent wrote
/// just before exiting.
const EXITED_PIPE_DRAIN_GRACE: Duration = Duration::from_secs(2);

pub(super) struct Inner {
    pub(super) connection: agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
    pub(super) events: AcpEventHub,
    pub(super) server_responders: ServerResponders,
    /// Flips to `true` once the transport can no longer answer requests
    /// (shutdown, or the process exited and its pipe drain grace elapsed).
    /// Requests without a deadline select on it so they cannot outlive the
    /// agent process.
    pub(super) closed: Arc<watch::Sender<bool>>,
    pub(super) client_info: AcpClientInfo,
    pub(super) pid: Option<u32>,
    /// Set once the caller stops the agent on purpose: the transport breaking
    /// from then on is the expected end of the connection, not a failure.
    pub(super) stopping: Arc<AtomicBool>,
    shutdown_tx: StdMutex<Option<oneshot::Sender<()>>>,
    kill_tx: StdMutex<Option<oneshot::Sender<()>>>,
    connection_task: StdMutex<Option<JoinHandle<()>>>,
    stderr_task: StdMutex<Option<JoinHandle<()>>>,
    reaper_task: StdMutex<Option<JoinHandle<()>>>,
}

impl Inner {
    pub(super) async fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.closed.send_replace(true);
        send_once(&self.shutdown_tx);
        send_once(&self.kill_tx);
        for slot in [&self.connection_task, &self.stderr_task, &self.reaper_task] {
            let task = slot.lock().ok().and_then(|mut task| task.take());
            if let Some(task) = task {
                let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.closed.send_replace(true);
        send_once(&self.shutdown_tx);
        send_once(&self.kill_tx);
    }
}

pub(super) async fn spawn_acp_subprocess(
    mut options: AcpSpawnOptions,
) -> Result<AcpClient, AcpError> {
    options
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    drop(options.spawn_guard.take());

    let process_tree =
        ProcessTreeControl::prepare(&mut options.command, options.process_tree_policy).map_err(
            |error| AcpError::Spawn(format!("process containment unavailable: {error}")),
        )?;

    let mut child = options
        .command
        .spawn()
        .map_err(|error| AcpError::Spawn(error.to_string()))?;
    if let Err(error) = process_tree.attach(&child) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(AcpError::Spawn(format!(
            "process containment unavailable: {error}"
        )));
    }
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AcpError::Protocol("missing ACP stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AcpError::Protocol("missing ACP stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AcpError::Protocol("missing ACP stderr".to_string()))?;

    assemble(
        stdin,
        stdout,
        stderr,
        Some(child),
        pid,
        options,
        Some(process_tree),
    )
    .await
}

#[cfg(test)]
pub(super) async fn spawn_acp_with_streams<R, E>(
    stdin: Box<dyn AsyncWrite + Send + Unpin>,
    stdout: R,
    stderr: E,
    client_info: AcpClientInfo,
) -> Result<AcpClient, AcpError>
where
    R: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    let options = AcpSpawnOptions::builder()
        .command(tokio::process::Command::new("/bin/false"))
        .client_info(client_info)
        .build();
    assemble(stdin, stdout, stderr, None, None, options, None).await
}

async fn assemble<W, R, E>(
    stdin: W,
    stdout: R,
    stderr: E,
    child: Option<Child>,
    pid: Option<u32>,
    options: AcpSpawnOptions,
    process_tree: Option<ProcessTreeControl>,
) -> Result<AcpClient, AcpError>
where
    W: AsyncWrite + Send + Unpin + 'static,
    R: AsyncRead + Send + Unpin + 'static,
    E: AsyncRead + Send + Unpin + 'static,
{
    let events = AcpEventHub::new();
    let closed = Arc::new(watch::Sender::new(false));
    let server_responders = Arc::new(StdMutex::new(HashMap::new()));
    let exit_sent = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));
    let max_line_bytes = options.max_line_bytes.unwrap_or(DEFAULT_MAX_LINE_BYTES);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (kill_tx, kill_rx) = oneshot::channel();

    let (connection, connection_task) = spawn_connection(
        stdin,
        stdout,
        events.clone(),
        Arc::clone(&server_responders),
        shutdown_rx,
        Arc::clone(&stopping),
    )
    .await?;

    let stderr_task = spawn_stderr_reader(
        stderr,
        max_line_bytes,
        options.stderr_policy.exposes_contents(),
    );
    let reaper_task = if let Some(child) = child {
        let process_tree = process_tree
            .ok_or_else(|| AcpError::Protocol("missing ACP process-tree control".to_string()))?;
        Some(spawn_reaper(
            child,
            kill_rx,
            events.clone(),
            Arc::clone(&exit_sent),
            Arc::clone(&server_responders),
            Arc::clone(&closed),
            process_tree,
        ))
    } else {
        drop(kill_rx);
        None
    };

    let inner = Arc::new(Inner {
        connection,
        events,
        server_responders,
        closed,
        client_info: options.client_info,
        pid,
        stopping,
        shutdown_tx: StdMutex::new(Some(shutdown_tx)),
        kill_tx: StdMutex::new(Some(kill_tx)),
        connection_task: StdMutex::new(Some(connection_task)),
        stderr_task: StdMutex::new(Some(stderr_task)),
        reaper_task: StdMutex::new(reaper_task),
    });
    Ok(AcpClient::from_inner(inner))
}

async fn spawn_connection<W, R>(
    stdin: W,
    stdout: R,
    events: AcpEventHub,
    server_responders: ServerResponders,
    shutdown_rx: oneshot::Receiver<()>,
    stopping: Arc<AtomicBool>,
) -> Result<
    (
        agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
        JoinHandle<()>,
    ),
    AcpError,
>
where
    W: AsyncWrite + Send + Unpin + 'static,
    R: AsyncRead + Send + Unpin + 'static,
{
    let transport = ByteStreams::new(stdin.compat_write(), stdout.compat());
    let (connection_tx, connection_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        let result = Client
            .builder()
            .name("cadencr")
            .with_handler(EventDispatchHandler::new(events, server_responders))
            .connect_with(transport, async move |connection| {
                let _ = connection_tx.send(connection.clone());
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;
        if let Err(error) = result {
            // A deliberate stop can race the agent's own exit (the service's
            // Ctrl-C reaches it too): its pipe then breaks first.
            if stopping.load(Ordering::SeqCst)
                || crate::domain::restart_continuations::is_shutting_down()
            {
                tracing::debug!(%error, "ACP connection closed while the agent was stopped");
            } else {
                tracing::warn!(%error, "ACP connection closed");
            }
        }
    });
    let connection = connection_rx
        .await
        .map_err(|_| AcpError::Protocol("ACP connection closed during startup".to_string()))?;
    Ok((connection, task))
}

fn spawn_reaper(
    mut child: Child,
    mut kill_rx: oneshot::Receiver<()>,
    events: AcpEventHub,
    exit_sent: Arc<AtomicBool>,
    server_responders: ServerResponders,
    closed: Arc<watch::Sender<bool>>,
    process_tree: ProcessTreeControl,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let pid = child.id();
        let status = tokio::select! {
            status = child.wait() => {
                if let Err(error) = process_tree.cleanup_after_exit(pid).await {
                    tracing::warn!(%error, "failed to clean up ACP descendant processes");
                }
                status
            },
            _ = &mut kill_rx => process_tree
                .terminate(&mut child, Duration::from_secs(1))
                .await,
        };
        match status {
            Ok(status) => send_process_exited(
                &events,
                &exit_sent,
                &server_responders,
                status.code(),
                exit_signal(&status),
            ),
            Err(error) => {
                tracing::warn!(%error, "failed to reap ACP process");
                send_process_exited(&events, &exit_sent, &server_responders, None, None);
            }
        }
        close_after_pipe_drain(closed);
    })
}

/// Requests normally fail as soon as stdout reaches EOF. A descendant that
/// inherited the pipe can keep it open after the agent died, so bound that
/// wait instead of letting `session/prompt` hang on a dead process. Detached
/// so `shutdown()` never waits for the grace.
fn close_after_pipe_drain(closed: Arc<watch::Sender<bool>>) {
    if *closed.borrow() {
        return;
    }
    tokio::spawn(async move {
        let mut observer = closed.subscribe();
        tokio::select! {
            _ = tokio::time::sleep(EXITED_PIPE_DRAIN_GRACE) => {
                closed.send_replace(true);
            }
            _ = observer.wait_for(|closed| *closed) => {}
        }
    });
}

fn send_process_exited(
    events: &AcpEventHub,
    exit_sent: &AtomicBool,
    server_responders: &ServerResponders,
    status: Option<i32>,
    signal: Option<i32>,
) {
    if exit_sent.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut responders) = server_responders.lock() {
        responders.clear();
    }
    if !events.send(AcpEvent::ProcessExited { status, signal }) {
        tracing::debug!(
            ?status,
            ?signal,
            "ACP process exited with no event subscriber"
        );
    }
}

fn send_once(slot: &StdMutex<Option<oneshot::Sender<()>>>) {
    if let Ok(mut slot) = slot.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}
