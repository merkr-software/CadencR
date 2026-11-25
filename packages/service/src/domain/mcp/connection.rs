//! A private socket per attached server and ACP runtime. The MCP subprocess
//! opens it when its client discovers tools and holds it for that connection.
mod reporter;

use std::collections::HashMap;
use std::io;
use std::os::unix::fs::PermissionsExt;

use futures::{stream::FuturesUnordered, StreamExt};
use tempfile::TempDir;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;

pub(crate) use reporter::Reporter;

use super::servers::{mcp_server_name, AgentType};
use super::trusted::is_cadencr_server;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeMcpServerConfig,
    RuntimeMcpServerStatus,
};

const SOCKET_ENV: &str = "CADENCR_MCP_STATUS_SOCKET";

struct Listener {
    name: String,
    socket: UnixListener,
    _directory: TempDir,
}

impl Listener {
    fn attach(servers: Option<&mut HashMap<String, RuntimeMcpServerConfig>>) -> Vec<Self> {
        let Some(servers) = servers else {
            return Vec::new();
        };
        let mut listeners = Vec::new();
        for &agent in AgentType::ALL {
            let name = mcp_server_name(agent);
            let Some(config) = servers.get_mut(&name) else {
                continue;
            };
            if !is_cadencr_server(config, agent) {
                continue;
            }
            match Self::bind(name.clone()) {
                Ok((listener, path)) => {
                    let RuntimeMcpServerConfig::Stdio { env, .. } = config;
                    env.get_or_insert_default().insert(SOCKET_ENV.into(), path);
                    listeners.push(listener);
                }
                Err(error) => tracing::warn!(%error, %name, "MCP connection reporting unavailable"),
            }
        }
        listeners
    }

    fn bind(name: String) -> io::Result<(Self, String)> {
        // macOS sockaddr_un is limited to 104 bytes. A long user TMPDIR
        // cannot accommodate the runtime-specific directory and socket name.
        let directory = tempfile::Builder::new()
            .prefix("cadencr-mcp-")
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir_in("/tmp")?;
        let path = directory.path().join("status");
        let socket = UnixListener::bind(&path)?;
        Ok((
            Self {
                name,
                socket,
                _directory: directory,
            },
            path.to_string_lossy().into_owned(),
        ))
    }

    async fn run(self, index: usize, statuses: watch::Sender<Vec<&'static str>>) {
        let mut clients = FuturesUnordered::new();
        loop {
            let next = tokio::select! {
                biased;
                result = self.socket.accept() => match result {
                    Ok((mut stream, _)) => {
                        clients.push(async move { wait_for_close(&mut stream).await });
                        "connected"
                    }
                    Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::ConnectionAborted) => continue,
                    Err(error) => {
                        tracing::warn!(%error, server = %self.name, "MCP status listener failed");
                        "unknown"
                    }
                },
                _ = clients.next(), if !clients.is_empty() => {
                    if !clients.is_empty() { continue; }
                    "disconnected"
                }
            };
            statuses.send_if_modified(|statuses| {
                let previous = std::mem::replace(&mut statuses[index], next);
                previous != next
            });
            if next == "unknown" {
                return;
            }
        }
    }
}

async fn wait_for_close(stream: &mut UnixStream) {
    // This is a liveness connection. EOF (including process death) releases it.
    if let Err(error) = stream.read_u8().await {
        if error.kind() != io::ErrorKind::UnexpectedEof {
            tracing::debug!(%error, "MCP status connection closed");
        }
    }
}

#[derive(Default)]
pub(crate) struct Connections {
    names: Vec<String>,
    statuses: Option<watch::Receiver<Vec<&'static str>>>,
    tasks: JoinSet<()>,
}

#[derive(Clone, Default)]
pub(crate) struct ConnectedServers {
    names: Vec<String>,
    statuses: Option<watch::Receiver<Vec<&'static str>>>,
}

impl ConnectedServers {
    pub(crate) fn contains(&self, server: &str) -> bool {
        self.names
            .iter()
            .position(|name| name == server)
            .zip(self.statuses.as_ref())
            .is_some_and(|(index, states)| states.borrow()[index] == "connected")
    }
}

impl Connections {
    pub(crate) fn attach(servers: Option<&mut HashMap<String, RuntimeMcpServerConfig>>) -> Self {
        Self::start(Listener::attach(servers))
    }

    fn start(listeners: Vec<Listener>) -> Self {
        let mut connections = Self::default();
        if !listeners.is_empty() {
            let (statuses, receiver) = watch::channel(vec!["configured"; listeners.len()]);
            connections.statuses = Some(receiver);
            for (index, listener) in listeners.into_iter().enumerate() {
                connections.names.push(listener.name.clone());
                connections
                    .tasks
                    .spawn(listener.run(index, statuses.clone()));
            }
        }
        connections
    }

    pub(crate) fn observed(&self) -> ConnectedServers {
        ConnectedServers {
            names: self.names.clone(),
            statuses: self.statuses.clone(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    pub(crate) fn apply_initial(&mut self, statuses: &mut [RuntimeMcpServerStatus]) {
        if let Some(observed) = &mut self.statuses {
            let current = observed.borrow_and_update();
            overlay(&self.names, statuses, |index| current[index]);
        }
    }

    // Called after queueing the initial snapshot. The receiver remembers its
    // version, so any transition since then still wakes the relay.
    pub(crate) fn publish_changes(
        &mut self,
        events: &mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    ) {
        if let Some(observed) = &self.statuses {
            self.tasks
                .spawn(publish_changes(observed.clone(), events.clone()));
        }
    }

    pub(crate) fn apply(&self, statuses: &mut [RuntimeMcpServerStatus]) {
        if let Some(observed) = &self.statuses {
            let current = observed.borrow();
            overlay(&self.names, statuses, |index| current[index]);
        } else {
            self.apply_disconnected(statuses);
        }
    }

    pub(crate) fn apply_disconnected(&self, statuses: &mut [RuntimeMcpServerStatus]) -> bool {
        !self.is_empty() && overlay(&self.names, statuses, |_| "disconnected")
    }

    pub(crate) async fn stop(&mut self) {
        self.tasks.shutdown().await;
        self.statuses = None;
    }
}

fn overlay(
    names: &[String],
    statuses: &mut [RuntimeMcpServerStatus],
    observed: impl Fn(usize) -> &'static str,
) -> bool {
    let mut applied = false;
    for status in statuses.iter_mut().filter(|s| s.status == "unknown") {
        if let Some(index) = names.iter().position(|name| *name == status.name) {
            status.status = observed(index).into();
            applied = true;
        }
    }
    applied
}

async fn publish_changes(
    mut observed: watch::Receiver<Vec<&'static str>>,
    events: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
) {
    while observed.changed().await.is_ok() {
        let Ok(permit) = events.reserve().await else {
            return;
        };
        // The consumer reads the latest snapshot. Changes during the wait
        // for queue capacity belong to this same invalidation.
        drop(observed.borrow_and_update());
        permit.send(Ok(RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::McpServersChanged,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const TIMEOUT: Duration = Duration::from_secs(2);
    const NAME: &str = "cadencr-workspace";

    fn row(name: &str, native: &str) -> RuntimeMcpServerStatus {
        RuntimeMcpServerStatus {
            name: name.into(),
            status: native.into(),
        }
    }

    fn status(connections: &Connections) -> String {
        let mut row = row(NAME, "unknown");
        connections.apply(std::slice::from_mut(&mut row));
        row.status
    }

    async fn changed(updates: &mut mpsc::Receiver<Result<RuntimeEvent, RuntimeError>>) {
        assert!(tokio::time::timeout(TIMEOUT, updates.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .mcp_servers_changed());
    }

    #[tokio::test]
    async fn only_the_last_client_disconnects_a_server_and_other_runtimes_are_independent() {
        let (listener, path) = Listener::bind(NAME.into()).unwrap();
        let (other_listener, other_path) = Listener::bind(NAME.into()).unwrap();
        let (tx, mut updates) = mpsc::channel(8);
        let (other_tx, mut other_updates) = mpsc::channel(8);
        let mut connections = Connections::start(vec![listener]);
        let mut other = Connections::start(vec![other_listener]);
        connections.publish_changes(&tx);
        other.publish_changes(&other_tx);
        assert_eq!(status(&connections), "configured");

        let child = Reporter::start(path.clone().into());
        child.tools_listed();
        changed(&mut updates).await;
        child.tools_listed();
        assert_eq!(status(&connections), "connected");
        assert_eq!(status(&other), "configured");
        assert!(other_updates.try_recv().is_err());

        let mut untouched = [row("external", "unknown"), row(NAME, "failed")];
        connections.apply(&mut untouched);
        assert_eq!(untouched[0].status, "unknown");
        assert_eq!(untouched[1].status, "failed");
        assert!(!connections.apply_disconnected(&mut untouched));

        let second = UnixStream::connect(&path).await.unwrap();
        let other_child = Reporter::start(other_path.into());
        other_child.tools_listed();
        changed(&mut other_updates).await;
        drop(child);
        assert!(
            tokio::time::timeout(Duration::from_millis(25), updates.recv())
                .await
                .is_err()
        );
        assert_eq!(status(&connections), "connected");
        drop(second);
        changed(&mut updates).await;
        assert_eq!(status(&connections), "disconnected");
        assert_eq!(status(&other), "connected");

        let replacement = Reporter::start(path.clone().into());
        replacement.tools_listed();
        changed(&mut updates).await;
        assert_eq!(status(&connections), "connected");
        connections.stop().await;
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(status(&connections), "disconnected");
        assert_eq!(status(&other), "connected");
    }

    #[tokio::test]
    async fn init_covers_existing_connections_and_the_relay_catches_later_changes() {
        let (listener, path) = Listener::bind(NAME.into()).unwrap();
        let mut connections = Connections::start(vec![listener]);
        let mut observed = connections.statuses.as_ref().unwrap().clone();
        let child = UnixStream::connect(&path).await.unwrap();
        tokio::time::timeout(TIMEOUT, observed.changed())
            .await
            .unwrap()
            .unwrap();

        let mut initial = [row(NAME, "unknown")];
        connections.apply_initial(&mut initial);
        assert_eq!(initial[0].status, "connected");
        let (tx, mut updates) = mpsc::channel(8);
        connections.publish_changes(&tx);
        assert!(
            tokio::time::timeout(Duration::from_millis(25), updates.recv())
                .await
                .is_err()
        );
        drop(child);
        changed(&mut updates).await;
        assert_eq!(status(&connections), "disconnected");
    }

    #[tokio::test]
    async fn listeners_keep_tracking_while_the_runtime_event_queue_is_full() {
        let (first, first_path) = Listener::bind(NAME.into()).unwrap();
        let (second, second_path) = Listener::bind("cadencr-project".into()).unwrap();
        let mut connections = Connections::start(vec![first, second]);
        let mut observed = connections.statuses.as_ref().unwrap().clone();
        let (tx, mut updates) = mpsc::channel(1);
        tx.send(Err(RuntimeError::new("occupy the event queue")))
            .await
            .unwrap();
        connections.publish_changes(&tx);

        let first = UnixStream::connect(first_path).await.unwrap();
        let _second = UnixStream::connect(second_path).await.unwrap();
        tokio::time::timeout(
            TIMEOUT,
            observed.wait_for(|states| states == &["connected", "connected"]),
        )
        .await
        .unwrap()
        .unwrap();
        drop(first);
        tokio::time::timeout(
            TIMEOUT,
            observed.wait_for(|states| states == &["disconnected", "connected"]),
        )
        .await
        .unwrap()
        .unwrap();

        assert!(updates.recv().await.unwrap().is_err());
        changed(&mut updates).await;
        assert_eq!(status(&connections), "disconnected");
        assert!(
            tokio::time::timeout(Duration::from_millis(25), updates.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn only_the_service_binary_with_matching_server_arguments_gets_a_status_socket() {
        let mut servers = super::super::trusted::test_support::injected_browser_servers();
        let own = servers["cadencr-browser"].clone();
        servers.insert("cadencr-project".into(), own.clone());
        servers.insert("external".into(), own);
        let listeners = Listener::attach(Some(&mut servers));
        assert_eq!(listeners.len(), 1);
        for (name, RuntimeMcpServerConfig::Stdio { env, .. }) in &servers {
            assert_eq!(
                env.as_ref().is_some_and(|env| env.contains_key(SOCKET_ENV)),
                name == "cadencr-browser"
            );
        }
        assert_eq!(Listener::attach(None).len(), 0);
    }
}
