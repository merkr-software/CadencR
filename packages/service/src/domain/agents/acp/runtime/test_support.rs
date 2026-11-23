use serde_json::{json, Value};
use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

use crate::domain::agents::acp::{AcpClient, AcpClientInfo, AcpEvent};

pub(crate) async fn build_in_memory_client() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
    let (client_stdout, agent_stdout) = duplex(64 * 1024);
    let (agent_stdin, client_stdin) = duplex(64 * 1024);
    let client = AcpClient::spawn_with_streams(
        Box::new(client_stdin),
        client_stdout,
        tokio::io::empty(),
        AcpClientInfo::default(),
    )
    .await
    .expect("in-memory ACP client should spawn");
    (client, agent_stdout, BufReader::new(agent_stdin))
}

pub(crate) fn spawn_event_barrier_acker(client: &AcpClient) {
    let mut events = client.subscribe_reliable();
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let AcpEvent::EventBarrier(barrier) = event {
                barrier.reach().await;
            }
        }
    });
}

pub(crate) fn assembled_prompt_session(
    client: &AcpClient,
    steering: bool,
) -> Box<dyn crate::domain::agents::adapter::AgentRuntimeSession> {
    use super::events_stream_blocks::EventIndexer;
    use super::lifecycle::NegotiatedSession;
    use super::provider_hooks::AcpProviderHooks;
    use super::session::AcpRuntimeSession;
    use crate::domain::agents::adapter::RuntimePermissionMode;

    struct NegotiatingHooks;
    impl AcpProviderHooks for NegotiatingHooks {
        fn normalize_tool_name(&self, name: &str) -> String {
            name.to_owned()
        }

        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }

        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            None
        }

        fn uses_negotiated_prompt_receipts(&self) -> bool {
            true
        }
    }

    let cwd = std::env::temp_dir();
    let negotiated = NegotiatedSession {
        session_id: "s-1".into(),
        model: None,
        mcp_servers: Vec::new(),
        context_window: None,
        current_mode: None,
        session_config: Default::default(),
        supports_session_close: false,
        supports_prompt_steering: steering,
        may_replay_history: false,
    };
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    spawn_event_barrier_acker(client);
    Box::new(
        AcpRuntimeSession::assemble()
            .client(client)
            .negotiated(&negotiated)
            .cwd(cwd)
            .rx(rx)
            .local_tx(tx)
            .hooks(std::sync::Arc::new(NegotiatingHooks))
            .indexer(std::sync::Arc::new(std::sync::Mutex::new(
                EventIndexer::default(),
            )))
            .call(),
    )
}

pub(crate) async fn read_request(reader: &mut BufReader<DuplexStream>) -> Value {
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .expect("ACP request frame should be readable");
    serde_json::from_str(line.trim()).expect("ACP request frame should be JSON")
}

pub(crate) async fn send_response(stdout: &mut DuplexStream, id: Value, result: Value) {
    write_json_frame(
        stdout,
        json!({ "jsonrpc": "2.0", "id": id, "result": result }),
    )
    .await;
}

pub(crate) async fn write_json_frame(stdout: &mut DuplexStream, value: Value) {
    let mut frame = serde_json::to_vec(&value).expect("ACP frame should serialize");
    frame.push(b'\n');
    stdout
        .write_all(&frame)
        .await
        .expect("ACP frame should write");
}
