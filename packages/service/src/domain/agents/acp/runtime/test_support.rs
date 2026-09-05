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
    let mut events = client.subscribe();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if let AcpEvent::EventBarrier(barrier) = event {
                barrier.notify_one();
            }
        }
    });
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
