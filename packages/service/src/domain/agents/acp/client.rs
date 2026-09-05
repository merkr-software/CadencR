use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{Agent, JsonRpcNotification, JsonRpcRequest, UntypedMessage};
use serde_json::Value;
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
use tokio::sync::{broadcast, Notify};

#[cfg(test)]
use crate::domain::agents::acp::client_spawn::spawn_acp_with_streams;
use crate::domain::agents::acp::client_spawn::{spawn_acp_subprocess, Inner};
use crate::domain::agents::acp::error::AcpError;
use crate::domain::agents::acp::process_tree::AcpProcessTreePolicy;
use crate::domain::agents::acp::types::{AcpClientInfo, AcpEvent};

/// Generic ACP subprocess client backed by the official ACP Rust SDK.
#[derive(Clone)]
pub struct AcpClient {
    inner: Arc<Inner>,
}

/// Options for `AcpClient::spawn`.
#[derive(bon::Builder)]
pub struct AcpSpawnOptions {
    pub command: Command,
    pub client_info: AcpClientInfo,
    /// Maximum size of one stderr line. ACP stdout is parsed by the official SDK.
    pub max_line_bytes: Option<usize>,
    /// Whether provider stderr may be written to Cadencr logs.
    #[builder(default)]
    pub stderr_policy: AcpStderrPolicy,
    /// Opt-in process-tree ownership. Built-ins preserve their current behavior.
    #[builder(default)]
    pub process_tree_policy: AcpProcessTreePolicy,
    pub spawn_guard: Option<Box<dyn Send + 'static>>,
}

/// Provider-neutral handling of ACP subprocess diagnostics.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum AcpStderrPolicy {
    /// Preserve the established built-in behavior.
    #[default]
    Log,
    /// Drain and bound stderr without surfacing its contents.
    Discard,
}

impl AcpStderrPolicy {
    pub(super) fn exposes_contents(self) -> bool {
        matches!(self, Self::Log)
    }
}

impl AcpClient {
    pub async fn spawn(options: AcpSpawnOptions) -> Result<Self, AcpError> {
        spawn_acp_subprocess(options).await
    }

    /// Test-only constructor around in-memory streams.
    #[doc(hidden)]
    #[cfg(test)]
    pub async fn spawn_with_streams<R, E>(
        stdin: Box<dyn AsyncWrite + Send + Unpin>,
        stdout: R,
        stderr: E,
        client_info: AcpClientInfo,
    ) -> Result<Self, AcpError>
    where
        R: AsyncRead + Send + Unpin + 'static,
        E: AsyncRead + Send + Unpin + 'static,
    {
        spawn_acp_with_streams(stdin, stdout, stderr, client_info).await
    }

    pub(super) fn from_inner(inner: Arc<Inner>) -> Self {
        Self { inner }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.inner.events.subscribe()
    }

    pub(crate) fn enqueue_event_barrier(&self) -> Result<Arc<Notify>, AcpError> {
        let barrier = Arc::new(Notify::new());
        self.inner
            .events
            .send(AcpEvent::EventBarrier(Arc::clone(&barrier)))
            .map_err(|_| AcpError::Protocol("ACP runtime event loop is unavailable".to_string()))?;
        Ok(barrier)
    }

    pub fn client_info(&self) -> &AcpClientInfo {
        &self.inner.client_info
    }

    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, AcpError> {
        let request = UntypedMessage::new(method, params).map_err(AcpError::from_acp)?;
        self.send_request_typed(request, timeout).await
    }

    pub async fn send_request_typed<Req>(
        &self,
        request: Req,
        timeout: Duration,
    ) -> Result<Req::Response, AcpError>
    where
        Req: JsonRpcRequest,
        Req::Response: Send,
    {
        let label = static_method_label(request.method());
        let pending = self
            .inner
            .connection
            .send_request_to(Agent, request)
            .block_task();
        tokio::time::timeout(timeout, pending)
            .await
            .map_err(|_| AcpError::Timeout(label))?
            .map_err(AcpError::from_acp)
    }

    pub async fn send_notification_typed<N>(&self, notification: N) -> Result<(), AcpError>
    where
        N: JsonRpcNotification,
    {
        self.inner
            .connection
            .send_notification_to(Agent, notification)
            .map_err(AcpError::from_acp)
    }

    pub async fn respond_server_request(&self, id: Value, result: Value) -> Result<(), AcpError> {
        let responder = self.take_server_responder(&id)?;
        responder.respond(result).map_err(AcpError::from_acp)
    }

    pub async fn reject_server_request(
        &self,
        id: Value,
        code: i64,
        message: &str,
    ) -> Result<(), AcpError> {
        let responder = self.take_server_responder(&id)?;
        responder
            .respond_with_error(agent_client_protocol::Error::new(code as i32, message))
            .map_err(AcpError::from_acp)
    }

    pub async fn shutdown(&self) {
        self.inner.shutdown().await;
    }

    fn take_server_responder(
        &self,
        id: &Value,
    ) -> Result<agent_client_protocol::Responder<Value>, AcpError> {
        self.inner
            .server_responders
            .lock()
            .map_err(|_| AcpError::Protocol("server responder lock poisoned".to_string()))?
            .remove(&server_request_key(id))
            .ok_or_else(|| AcpError::Protocol(format!("no pending ACP server request for id {id}")))
    }
}

pub(crate) fn server_request_key(id: &Value) -> String {
    serde_json::to_string(id).unwrap_or_else(|_| id.to_string())
}

fn static_method_label(method: &str) -> &'static str {
    match method {
        "initialize" => "initialize",
        "authenticate" => "authenticate",
        "session/new" => "session/new",
        "session/load" => "session/load",
        "session/prompt" => "session/prompt",
        "session/cancel" => "session/cancel",
        "session/set_mode" => "session/set_mode",
        "session/set_config_option" => "session/set_config_option",
        "fs/read_text_file" => "fs/read_text_file",
        "fs/write_text_file" => "fs/write_text_file",
        _ => "request",
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};

    use agent_client_protocol::UntypedMessage;

    use super::{AcpClient, AcpClientInfo, AcpSpawnOptions, AcpStderrPolicy};
    use crate::domain::agents::acp::error::AcpError;
    use crate::domain::agents::acp::types::AcpEvent;
    #[cfg(unix)]
    use crate::domain::agents::acp::{AcpProcessTreeLimits, AcpProcessTreePolicy};

    #[test]
    fn spawn_options_builder_defaults_transport_controls() {
        let options = AcpSpawnOptions::builder()
            .command(tokio::process::Command::new("/bin/false"))
            .client_info(AcpClientInfo::default())
            .build();

        assert!(options.max_line_bytes.is_none());
        assert_eq!(options.stderr_policy, AcpStderrPolicy::Log);
        assert_eq!(
            options.process_tree_policy,
            super::AcpProcessTreePolicy::Inherit
        );
        assert!(options.stderr_policy.exposes_contents());
        assert!(options.spawn_guard.is_none());
    }

    #[test]
    fn discard_stderr_policy_never_exposes_provider_contents() {
        assert!(!AcpStderrPolicy::Discard.exposes_contents());
    }

    #[cfg(unix)]
    #[test]
    fn acp_descendant_helper() {
        let Some(pid_file) = std::env::var_os("ACP_TREE_TEST_PID_FILE") else {
            return;
        };
        let mut descendant = std::process::Command::new("/bin/sleep")
            .arg("60")
            .spawn()
            .expect("spawn ACP descendant");
        std::fs::write(pid_file, descendant.id().to_string()).expect("write descendant pid");
        let _ = descendant.wait();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn isolated_acp_shutdown_terminates_descendants() {
        let directory = tempfile::tempdir().expect("test directory");
        let pid_file = directory.path().join("acp-descendant.pid");
        let test_module = module_path!()
            .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::"))
            .unwrap_or(module_path!());
        let helper_name = format!("{test_module}::acp_descendant_helper");
        let mut command =
            tokio::process::Command::new(std::env::current_exe().expect("current test executable"));
        command
            .args(["--exact", helper_name.as_str(), "--nocapture"])
            .env("ACP_TREE_TEST_PID_FILE", &pid_file)
            .current_dir(directory.path());
        let client = AcpClient::spawn(
            AcpSpawnOptions::builder()
                .command(command)
                .client_info(AcpClientInfo::default())
                .process_tree_policy(AcpProcessTreePolicy::Isolated(AcpProcessTreeLimits {
                    cpu_time_seconds: 60,
                    memory_bytes: 256 * 1024 * 1024,
                    max_processes: 4,
                }))
                .build(),
        )
        .await
        .expect("spawn isolated ACP process");
        let pid = wait_for_test_pid(&pid_file).await;

        client.shutdown().await;

        wait_for_process_exit(pid).await;
    }

    #[cfg(unix)]
    async fn wait_for_test_pid(path: &std::path::Path) -> libc::pid_t {
        for _ in 0..100 {
            if let Ok(contents) = std::fs::read_to_string(path) {
                return contents.parse().expect("numeric ACP descendant pid");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("ACP helper did not publish its descendant pid");
    }

    #[cfg(unix)]
    async fn wait_for_process_exit(pid: libc::pid_t) {
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("ACP descendant {pid} survived client shutdown");
    }

    async fn build_in_memory_client() -> (
        AcpClient,
        tokio::io::DuplexStream,
        BufReader<tokio::io::DuplexStream>,
    ) {
        let (client_reads_stdout, agent_writes_stdout) = duplex(64 * 1024);
        let (agent_reads_stdin, client_writes_stdin) = duplex(64 * 1024);
        let client = AcpClient::spawn_with_streams(
            Box::new(client_writes_stdin),
            client_reads_stdout,
            tokio::io::empty(),
            AcpClientInfo::default(),
        )
        .await
        .unwrap();
        (
            client,
            agent_writes_stdout,
            BufReader::new(agent_reads_stdin),
        )
    }

    #[tokio::test]
    async fn request_round_trips_response() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let req = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("ping", json!({}), Duration::from_secs(1))
                    .await
            }
        });
        let parsed = read_frame(&mut agent_stdin).await;
        let id = parsed["id"].as_str().unwrap();
        uuid::Uuid::parse_str(id).expect("crate-backed client ids are UUIDs");
        assert_eq!(parsed["method"], "ping");
        write_frame(
            &mut agent_stdout,
            json!({ "jsonrpc": "2.0", "id": id, "result": { "pong": true } }),
        )
        .await;
        assert_eq!(req.await.unwrap().unwrap(), json!({ "pong": true }));
    }

    #[tokio::test]
    async fn request_surfaces_rpc_errors() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let req = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("oops", json!({}), Duration::from_secs(1))
                    .await
            }
        });
        let parsed = read_frame(&mut agent_stdin).await;
        let id = parsed["id"].as_str().unwrap();
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "method not found" }
            }),
        )
        .await;
        let err = req.await.unwrap().expect_err("should be Rpc error");
        assert!(matches!(err, AcpError::Rpc { code: -32601, .. }));
    }

    #[tokio::test]
    async fn request_times_out_when_no_response() {
        let (client, _agent_stdout, _agent_stdin) = build_in_memory_client().await;
        let err = client
            .request_with_timeout("session/prompt", json!({}), Duration::from_millis(50))
            .await
            .expect_err("should time out");
        assert!(matches!(err, AcpError::Timeout("session/prompt")));
    }

    #[tokio::test]
    async fn notify_writes_a_frame_with_no_id() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let notification = UntypedMessage::new("session/cancel", json!({"sessionId": "s1"}))
            .expect("test notification method is valid");
        client.send_notification_typed(notification).await.unwrap();
        let parsed = read_frame(&mut agent_stdin).await;
        assert!(parsed.get("id").is_none());
        assert_eq!(parsed["method"], "session/cancel");
    }

    #[tokio::test]
    async fn server_request_is_broadcast_to_subscribers() {
        let (client, mut agent_stdout, _agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe();
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "id": "perm-7",
                "method": "session/request_permission",
                "params": { "ok": true }
            }),
        )
        .await;
        let evt = tokio::time::timeout(Duration::from_secs(1), subscriber.recv())
            .await
            .unwrap()
            .unwrap();
        let AcpEvent::ServerRequest(request) = evt else {
            panic!("expected server request");
        };
        assert_eq!(request.id(), &json!("perm-7"));
        assert_eq!(request.method(), "session/request_permission");
        assert_eq!(request.params()["ok"], true);
    }

    #[tokio::test]
    async fn responding_server_request_uses_crate_responder() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "id": "perm-7",
                "method": "session/request_permission",
                "params": {}
            }),
        )
        .await;
        let mut subscriber = client.subscribe();
        let _ = tokio::time::timeout(Duration::from_secs(1), subscriber.recv())
            .await
            .unwrap()
            .unwrap();
        client
            .respond_server_request(
                json!("perm-7"),
                json!({ "outcome": "selected", "optionId": "ok" }),
            )
            .await
            .unwrap();
        let parsed = read_frame(&mut agent_stdin).await;
        assert_eq!(parsed["id"], "perm-7");
        assert_eq!(parsed["result"]["outcome"], "selected");
    }

    async fn read_frame(reader: &mut BufReader<tokio::io::DuplexStream>) -> serde_json::Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn write_frame(writer: &mut tokio::io::DuplexStream, value: serde_json::Value) {
        writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }
}
