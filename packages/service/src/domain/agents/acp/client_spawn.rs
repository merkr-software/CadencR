//! Official ACP SDK connection setup for [`AcpClient`].

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use agent_client_protocol::{
    ByteStreams, Client, Dispatch, HandleDispatchFrom, Handled, Responder,
};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::process::Child;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::domain::agents::acp::client::{server_request_key, AcpClient, AcpSpawnOptions};
use crate::domain::agents::acp::error::AcpError;
use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};
use crate::domain::agents::acp::process_tree::ProcessTreeControl;
use crate::domain::agents::acp::types::{AcpClientInfo, AcpEvent};

const DEFAULT_MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
type ServerResponders = Arc<StdMutex<HashMap<String, Responder<Value>>>>;

pub(super) struct Inner {
    pub(super) connection: agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
    pub(super) events: broadcast::Sender<AcpEvent>,
    pub(super) server_responders: ServerResponders,
    pub(super) client_info: AcpClientInfo,
    pub(super) pid: Option<u32>,
    shutdown_tx: StdMutex<Option<oneshot::Sender<()>>>,
    kill_tx: StdMutex<Option<oneshot::Sender<()>>>,
    connection_task: StdMutex<Option<JoinHandle<()>>>,
    stderr_task: StdMutex<Option<JoinHandle<()>>>,
    reaper_task: StdMutex<Option<JoinHandle<()>>>,
}

impl Inner {
    pub(super) async fn shutdown(&self) {
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
    let (events, _) = broadcast::channel(4096);
    let server_responders = Arc::new(StdMutex::new(HashMap::new()));
    let exit_sent = Arc::new(AtomicBool::new(false));
    let max_line_bytes = options.max_line_bytes.unwrap_or(DEFAULT_MAX_LINE_BYTES);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let (kill_tx, kill_rx) = oneshot::channel();

    let (connection, connection_task) = spawn_connection(
        stdin,
        stdout,
        events.clone(),
        Arc::clone(&server_responders),
        shutdown_rx,
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
        client_info: options.client_info,
        pid,
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
    events: broadcast::Sender<AcpEvent>,
    server_responders: ServerResponders,
    shutdown_rx: oneshot::Receiver<()>,
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
            .with_handler(BroadcastHandler::new(events, server_responders))
            .connect_with(transport, async move |connection| {
                let _ = connection_tx.send(connection.clone());
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;
        if let Err(error) = result {
            tracing::warn!(%error, "ACP connection closed");
        }
    });
    let connection = connection_rx
        .await
        .map_err(|_| AcpError::Protocol("ACP connection closed during startup".to_string()))?;
    Ok((connection, task))
}

#[derive(Clone)]
struct BroadcastHandler {
    events: broadcast::Sender<AcpEvent>,
    server_responders: ServerResponders,
}

impl BroadcastHandler {
    fn new(events: broadcast::Sender<AcpEvent>, server_responders: ServerResponders) -> Self {
        Self {
            events,
            server_responders,
        }
    }
}

impl HandleDispatchFrom<agent_client_protocol::Agent> for BroadcastHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _connection: agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        match message {
            Dispatch::Notification(notification) => {
                let (method, params) = notification.into_parts();
                let event = AcpNotification::from_parts(method, params);
                let _ = self.events.send(AcpEvent::Notification(event));
                Ok(Handled::Yes)
            }
            Dispatch::Request(request, responder) => {
                let id = responder.id();
                let (method, params) = request.into_parts();
                let key = server_request_key(&id);
                self.server_responders
                    .lock()
                    .map_err(|_| agent_client_protocol::Error::internal_error())?
                    .insert(key.clone(), responder);
                let event = AcpServerRequest::from_parts(id, method, params);
                if self.events.send(AcpEvent::ServerRequest(event)).is_err() {
                    let responder = self
                        .server_responders
                        .lock()
                        .map_err(|_| agent_client_protocol::Error::internal_error())?
                        .remove(&key);
                    if let Some(responder) = responder {
                        responder.respond_with_internal_error(
                            "ACP server request had no active receiver",
                        )?;
                    }
                }
                Ok(Handled::Yes)
            }
            Dispatch::Response(result, router) => Ok(Handled::No {
                message: Dispatch::Response(result, router),
                retry: false,
            }),
        }
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "CadencrAcpBroadcastHandler"
    }
}

fn spawn_stderr_reader<R>(stderr: R, max_line_bytes: usize, log_contents: bool) -> JoinHandle<()>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_bounded_line(&mut reader, max_line_bytes).await {
                Ok(Some(line)) => {
                    if log_contents {
                        tracing::warn!(target: "acp", "{line}");
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "ACP stderr read failed");
                    break;
                }
            }
        }
    })
}

fn spawn_reaper(
    mut child: Child,
    mut kill_rx: oneshot::Receiver<()>,
    events: broadcast::Sender<AcpEvent>,
    exit_sent: Arc<AtomicBool>,
    server_responders: ServerResponders,
    process_tree: ProcessTreeControl,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let pid = child.id();
        let status = tokio::select! {
            status = child.wait() => {
                if let Err(error) = process_tree.cleanup_after_exit(pid) {
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
    })
}

fn send_process_exited(
    events: &broadcast::Sender<AcpEvent>,
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
    let _ = events.send(AcpEvent::ProcessExited { status, signal });
}

async fn read_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> Result<Option<String>, AcpError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(take) > max_line_bytes {
            reader.consume(take);
            return Err(AcpError::Protocol(format!(
                "ACP line exceeded {max_line_bytes} bytes"
            )));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Ok(Some(String::from_utf8_lossy(&line).to_string()))
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
