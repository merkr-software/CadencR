//! ACP v1 stdio proxy: host ⇄ connector (ACP agent) ⇄ `agent acp` (connector
//! as ACP client). Standard traffic is forwarded; Cursor specifics (model
//! companions, access modes, tool names, `cursor/*` extensions) are
//! translated here because the host's installed-provider adapter is generic.

mod child;
mod child_messages;
mod config;
mod gates;
mod host_requests;
mod restart;
mod rpc;
mod state;
mod subagent_messages;

use std::process::ExitCode;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::process::ChildStdout;
use tokio::sync::{mpsc, OnceCell};

use crate::access::AccessMode;
use crate::cli::models::{list_models, CursorModel};

pub use child::Launch;
use child::{spawn_child, write_lines, ChildConn};
use rpc::{classify, Incoming, Peer, RpcError, PARSE_ERROR};
use state::ProxyState;

const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
const WRITER_DRAIN: Duration = Duration::from_secs(2);

pub struct Proxy {
    host: Peer,
    launch: Launch,
    child: Mutex<Arc<ChildConn>>,
    state: Mutex<ProxyState>,
    catalog: OnceCell<Vec<CursorModel>>,
    /// Serializes access-mode changes (each may restart the child).
    access_lock: tokio::sync::Mutex<()>,
    fatal: mpsc::UnboundedSender<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub async fn run(launch: Launch) -> std::io::Result<ExitCode> {
    run_with_io(tokio::io::stdin(), tokio::io::stdout(), launch).await
}

pub async fn run_with_io<R, W>(reader: R, writer: W, launch: Launch) -> std::io::Result<ExitCode>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (host_tx, host_rx) = mpsc::unbounded_channel();
    let writer_task = tokio::spawn(write_lines(writer, host_rx, "Cadencr"));
    let (fatal_tx, mut fatal_rx) = mpsc::unbounded_channel();
    let proxy = Proxy::start(Peer::new("Cadencr", host_tx), launch, fatal_tx)?;
    tokio::spawn({
        let proxy = Arc::clone(&proxy);
        async move {
            proxy.catalog().await;
        }
    });
    let mut lines = BufReader::new(reader).lines();
    let code = loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => proxy.handle_host_line(&line),
                Ok(None) => break ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("cursor connector: reading from Cadencr failed: {error}");
                    break ExitCode::FAILURE;
                }
            },
            Some(reason) = fatal_rx.recv() => {
                eprintln!("cursor connector: {reason}");
                break ExitCode::FAILURE;
            }
            () = termination_signal() => break ExitCode::SUCCESS,
        }
    };
    proxy.shutdown().await;
    if tokio::time::timeout(WRITER_DRAIN, writer_task)
        .await
        .is_err()
    {
        eprintln!("cursor connector: pending output to Cadencr was not flushed");
    }
    Ok(code)
}

#[cfg(unix)]
async fn termination_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) {
        (Ok(mut term), Ok(mut interrupt)) => {
            tokio::select! {
                _ = term.recv() => {}
                _ = interrupt.recv() => {}
            }
        }
        _ => {
            eprintln!("cursor connector: signal handlers unavailable; relying on stdin EOF");
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(not(unix))]
async fn termination_signal() {
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}

impl Proxy {
    fn start(
        host: Peer,
        launch: Launch,
        fatal: mpsc::UnboundedSender<String>,
    ) -> std::io::Result<Arc<Self>> {
        let access = AccessMode::Default;
        let spawned = spawn_child(&launch, access, 1)?;
        let proxy = Arc::new(Self {
            host,
            launch,
            child: Mutex::new(Arc::clone(&spawned.conn)),
            state: Mutex::new(ProxyState::new(access, 1)),
            catalog: OnceCell::new(),
            access_lock: tokio::sync::Mutex::new(()),
            fatal,
        });
        proxy.read_child(spawned.conn, spawned.stdout);
        Ok(proxy)
    }

    fn child(&self) -> Arc<ChildConn> {
        Arc::clone(&lock(&self.child))
    }

    fn state(&self) -> MutexGuard<'_, ProxyState> {
        lock(&self.state)
    }

    /// Swap in a freshly spawned child; the caller retires the old one.
    fn replace_child(self: &Arc<Self>, access: AccessMode) -> std::io::Result<Arc<ChildConn>> {
        let generation = self.state().generation + 1;
        let spawned = spawn_child(&self.launch, access, generation)?;
        {
            let mut state = self.state();
            state.generation = generation;
            state.access = access;
            state.child_access = access;
        }
        let old = std::mem::replace(&mut *lock(&self.child), Arc::clone(&spawned.conn));
        self.read_child(spawned.conn, spawned.stdout);
        Ok(old)
    }

    fn read_child(self: &Arc<Self>, conn: Arc<ChildConn>, stdout: ChildStdout) {
        let proxy = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                        Ok(message) => proxy.handle_child_message(&conn, message),
                        Err(_) => eprintln!("cursor agent (non-JSON output): {line}"),
                    },
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("cursor connector: reading from Cursor Agent failed: {error}");
                        break;
                    }
                }
            }
            conn.peer.fail_all("Cursor Agent exited");
            if proxy.state().generation == conn.generation {
                // Nothing to report to if the connector is already exiting.
                let _ = proxy.fatal.send("Cursor Agent exited".to_string());
            }
        });
    }

    /// The cold `agent models` catalog for the live `model` selector. Failure
    /// leaves it empty: the view then derives ids from Cursor's live models.
    async fn catalog(&self) -> &[CursorModel] {
        self.catalog
            .get_or_init(|| async {
                let fetch = list_models(&self.launch.binary, None);
                match tokio::time::timeout(CATALOG_TIMEOUT, fetch).await {
                    Ok(Ok(models)) => models,
                    Ok(Err(error)) => {
                        eprintln!("cursor connector: {error}");
                        Vec::new()
                    }
                    Err(_) => {
                        eprintln!("cursor connector: `agent models` did not answer in time");
                        Vec::new()
                    }
                }
            })
            .await
    }

    fn catalog_now(&self) -> &[CursorModel] {
        self.catalog.get().map(Vec::as_slice).unwrap_or_default()
    }

    /// The host's `configOptions` view of a session.
    fn host_options(&self, session_id: &str) -> Vec<Value> {
        let state = self.state();
        let access = state.access;
        state
            .sessions
            .get(session_id)
            .map(|session| session.config.host_options(self.catalog_now(), access))
            .unwrap_or_else(|| vec![access.config_option()])
    }

    fn handle_host_line(self: &Arc<Self>, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            self.host
                .respond(Value::Null, Err(RpcError::new(PARSE_ERROR, "invalid JSON")));
            return;
        };
        match classify(message) {
            Incoming::Response(response) => self.host.resolve(&response),
            Incoming::Notification { method, params } => self.child().peer.notify(&method, params),
            Incoming::Request { id, method, params } => {
                self.handle_host_request(id, method, params)
            }
            Incoming::Invalid => {
                self.host.respond(
                    Value::Null,
                    Err(RpcError::new(PARSE_ERROR, "not a JSON-RPC frame")),
                );
            }
        }
    }

    /// Forward a host request unchanged and relay Cursor's answer. The request
    /// is written immediately, so frame order matches the host's.
    fn passthrough_to_child(self: &Arc<Self>, id: Value, method: &str, params: Value) {
        let rx = self.child().peer.start_request(method, params);
        let proxy = Arc::clone(self);
        tokio::spawn(async move {
            let result = rpc::await_response(rx, "Cursor Agent").await;
            proxy.host.respond(id, result);
        });
    }

    /// Forward a Cursor request (fs/*, terminal/*, unknown) to the host.
    fn passthrough_to_host(&self, conn: &Arc<ChildConn>, id: Value, method: &str, params: Value) {
        let rx = self.host.start_request(method, params);
        let conn = Arc::clone(conn);
        tokio::spawn(async move {
            conn.peer
                .respond(id, rpc::await_response(rx, "Cadencr").await);
        });
    }

    /// Run a request handler off the reader loop and send its result.
    fn respond_async<F>(self: &Arc<Self>, id: Value, handler: F)
    where
        F: std::future::Future<Output = rpc::RpcResult> + Send + 'static,
    {
        let proxy = Arc::clone(self);
        tokio::spawn(async move {
            let result = handler.await;
            proxy.host.respond(id, result);
        });
    }

    async fn shutdown(&self) {
        let child = self.child();
        child.terminate().await;
        self.host.fail_all("the connector is shutting down");
        self.host.close();
    }
}

/// Session id carried by request params.
fn session_id_of(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn invalid_params(message: &str) -> RpcError {
    RpcError::new(rpc::INVALID_PARAMS, message)
}

fn text_chunk(session_id: &str, text: &str) -> Value {
    json!({
        "sessionId": session_id,
        "update": {
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
        }
    })
}
