//! Optional message-level rewrite between an ACP agent process and the client.
//!
//! The host routes only standard ACP and its documented `_meta.cadencr`
//! conventions. A provider whose CLI speaks proprietary extensions can sit a
//! transform on the wire, exactly like an external connector process would,
//! and translate both directions without the runtime learning about them.
//! Lines that are not JSON pass through unchanged.

use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, DuplexStream};
use tokio::sync::mpsc::{self, Receiver, Sender, WeakSender};

/// Where a transform sends the messages one incoming message became.
#[derive(Debug, Default, PartialEq)]
pub struct WireRoute {
    pub to_client: Vec<Value>,
    pub to_agent: Vec<Value>,
}

impl WireRoute {
    pub fn to_client(message: Value) -> Self {
        Self {
            to_client: vec![message],
            to_agent: Vec::new(),
        }
    }

    pub fn to_agent(message: Value) -> Self {
        Self {
            to_client: Vec::new(),
            to_agent: vec![message],
        }
    }

    pub fn dropped() -> Self {
        Self::default()
    }
}

/// A sender the transform keeps to reach the client on its own (a message the
/// agent never sent). It does not keep the client's stream open once the
/// agent's output ended.
#[derive(Clone)]
pub struct WireInjector(WeakSender<Line>);

impl WireInjector {
    /// `false` once the client side is gone.
    pub async fn send_to_client(&self, message: Value) -> bool {
        match self.0.upgrade() {
            Some(sender) => sender.send(Line::Json(message)).await.is_ok(),
            None => false,
        }
    }
}

pub trait AcpWireTransform: Send + Sync + 'static {
    /// A message the agent wrote.
    fn agent_wrote(&self, message: Value) -> WireRoute;
    /// A message the client wrote.
    fn client_wrote(&self, message: Value) -> WireRoute;
    /// Called once, when the wire starts.
    fn start(&self, _injector: WireInjector) {}
}

#[derive(Debug)]
pub(super) enum Line {
    Json(Value),
    Raw(String),
}

/// The client's ends of an interposed wire: it writes `stdin` and reads
/// `stdout` as it would the agent's pipes.
pub(super) struct InterposedWire {
    pub(super) stdin: DuplexStream,
    pub(super) stdout: DuplexStream,
}

const WIRE_BUFFER_BYTES: usize = 1 << 20;
/// Lines queued per direction: a slow reader then blocks the other side's
/// pump, which stops reading its pipe, as it would without the transform.
const WIRE_QUEUE_LINES: usize = 256;

/// Pump the agent's pipes through `transform`. The pumps end with the streams:
/// the agent's EOF ends the client's stdout, the client closing its stdin
/// closes the agent's.
pub(super) fn interpose<W, R>(
    agent_stdin: W,
    agent_stdout: R,
    transform: Arc<dyn AcpWireTransform>,
) -> InterposedWire
where
    W: AsyncWrite + Send + Unpin + 'static,
    R: AsyncRead + Send + Unpin + 'static,
{
    let (client_stdin, from_client) = tokio::io::duplex(WIRE_BUFFER_BYTES);
    let (to_client, client_stdout) = tokio::io::duplex(WIRE_BUFFER_BYTES);
    let (client_tx, client_rx) = mpsc::channel(WIRE_QUEUE_LINES);
    let (agent_tx, agent_rx) = mpsc::channel(WIRE_QUEUE_LINES);
    tokio::spawn(write_lines(client_rx, to_client));
    tokio::spawn(write_lines(agent_rx, agent_stdin));
    transform.start(WireInjector(client_tx.downgrade()));
    tokio::spawn(read_agent(
        agent_stdout,
        Arc::clone(&transform),
        client_tx,
        agent_tx.downgrade(),
    ));
    tokio::spawn(read_client(from_client, transform, agent_tx));
    InterposedWire {
        stdin: client_stdin,
        stdout: client_stdout,
    }
}

async fn read_agent<R: AsyncRead + Unpin>(
    stdout: R,
    transform: Arc<dyn AcpWireTransform>,
    client: Sender<Line>,
    agent: WeakSender<Line>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "ACP agent output ended with a read error");
                break;
            }
        };
        let route = match serde_json::from_str::<Value>(&line) {
            Ok(message) => transform.agent_wrote(message),
            Err(_) => {
                if client.send(Line::Raw(line)).await.is_err() {
                    break;
                }
                continue;
            }
        };
        if !deliver(route, &client, agent.upgrade().as_ref()).await {
            break;
        }
    }
}

async fn read_client(
    stdin: DuplexStream,
    transform: Arc<dyn AcpWireTransform>,
    agent: Sender<Line>,
) {
    let mut lines = BufReader::new(stdin).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(%error, "ACP client input ended with a read error");
                break;
            }
        };
        let sent = match serde_json::from_str::<Value>(&line) {
            Ok(message) => {
                let route = transform.client_wrote(message);
                // Replies to the client come back through the agent reader's
                // channel only; a transform answering the client directly
                // here is not supported.
                if !route.to_client.is_empty() {
                    tracing::warn!("ACP wire transform answered the client from a client message");
                }
                send_all(&agent, route.to_agent).await
            }
            Err(_) => agent.send(Line::Raw(line)).await.is_ok(),
        };
        if !sent {
            break;
        }
    }
}

/// `false` once the client side is gone. A reply to an agent whose stdin
/// already closed (it is exiting) is reported and dropped.
async fn deliver(route: WireRoute, client: &Sender<Line>, agent: Option<&Sender<Line>>) -> bool {
    if !route.to_agent.is_empty() {
        let sent = match agent {
            Some(agent) => send_all(agent, route.to_agent).await,
            None => false,
        };
        if !sent {
            tracing::warn!("ACP agent stdin closed before a wire transform reply");
        }
    }
    send_all(client, route.to_client).await
}

async fn send_all(peer: &Sender<Line>, messages: Vec<Value>) -> bool {
    for message in messages {
        if peer.send(Line::Json(message)).await.is_err() {
            return false;
        }
    }
    true
}

async fn write_lines<W: AsyncWrite + Unpin>(mut lines: Receiver<Line>, mut writer: W) {
    while let Some(line) = lines.recv().await {
        let mut text = match line {
            Line::Json(message) => message.to_string(),
            Line::Raw(text) => text,
        };
        text.push('\n');
        if let Err(error) = writer.write_all(text.as_bytes()).await {
            tracing::debug!(%error, "ACP wire peer closed");
            return;
        }
        if let Err(error) = writer.flush().await {
            tracing::debug!(%error, "ACP wire peer closed");
            return;
        }
    }
    if let Err(error) = writer.shutdown().await {
        tracing::debug!(%error, "ACP wire peer already closed");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    use super::{interpose, AcpWireTransform, WireInjector, WireRoute};

    /// Tags agent messages, answers `ping` requests itself, injects on start.
    #[derive(Default)]
    struct Tagger {
        injector: Mutex<Option<WireInjector>>,
    }

    impl AcpWireTransform for Tagger {
        fn agent_wrote(&self, mut message: Value) -> WireRoute {
            if message["method"] == "ping" {
                return WireRoute::to_agent(json!({"id": message["id"], "result": "pong"}));
            }
            message["tagged"] = json!(true);
            WireRoute::to_client(message)
        }

        fn client_wrote(&self, mut message: Value) -> WireRoute {
            message["seen"] = json!(true);
            WireRoute::to_agent(message)
        }

        fn start(&self, injector: WireInjector) {
            let sender = injector.clone();
            tokio::spawn(async move {
                assert!(sender.send_to_client(json!({"injected": 1})).await);
            });
            *self.injector.lock().unwrap() = Some(injector);
        }
    }

    #[tokio::test]
    async fn rewrites_both_directions_answers_the_agent_and_injects() {
        let (agent_stdin, agent_reads) = tokio::io::duplex(4096);
        let (mut agent_writes, agent_stdout) = tokio::io::duplex(4096);
        let wire = interpose(agent_stdin, agent_stdout, Arc::new(Tagger::default()));
        let mut client_reads = BufReader::new(wire.stdout).lines();
        let mut agent_lines = BufReader::new(agent_reads).lines();
        let mut client_stdin = wire.stdin;

        let first: Value =
            serde_json::from_str(&client_reads.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(first, json!({"injected": 1}));

        agent_writes
            .write_all(b"{\"method\":\"note\"}\nnot json\n{\"id\":7,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let note: Value =
            serde_json::from_str(&client_reads.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(note, json!({"method": "note", "tagged": true}));
        assert_eq!(client_reads.next_line().await.unwrap().unwrap(), "not json");
        let pong: Value =
            serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(pong, json!({"id": 7, "result": "pong"}));

        client_stdin.write_all(b"{\"id\":1}\n").await.unwrap();
        let forwarded: Value =
            serde_json::from_str(&agent_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(forwarded, json!({"id": 1, "seen": true}));

        drop(agent_writes);
        assert!(client_reads.next_line().await.unwrap().is_none());
        drop(client_stdin);
        assert!(agent_lines.next_line().await.unwrap().is_none());
    }
}
