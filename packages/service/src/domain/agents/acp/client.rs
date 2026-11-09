use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::{Agent, JsonRpcNotification, JsonRpcRequest, UntypedMessage};
use serde_json::Value;
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot};

#[cfg(test)]
use crate::domain::agents::acp::client_spawn::spawn_acp_with_streams;
use crate::domain::agents::acp::client_spawn::{spawn_acp_subprocess, Inner};
use crate::domain::agents::acp::error::AcpError;
use crate::domain::agents::acp::event_hub::AcpReliableEventReceiver;
use crate::domain::agents::acp::process_tree::AcpProcessTreePolicy;
use crate::domain::agents::acp::types::{AcpClientInfo, AcpEvent, AcpEventBarrier};

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

    /// Best-effort observer: lags (and skips) under load and never sees
    /// barriers. Only for short-lived probes; the runtime uses
    /// [`Self::subscribe_reliable`].
    pub fn subscribe(&self) -> broadcast::Receiver<AcpEvent> {
        self.inner.events.subscribe()
    }

    /// Ordered, lossless subscription; overflow ends it with a visible
    /// `AcpEvent::TransportError` instead of skipping events.
    pub fn subscribe_reliable(&self) -> AcpReliableEventReceiver {
        self.inner.events.subscribe_reliable()
    }

    /// Queue a fence behind every event received so far. The receiver
    /// resolves once the event loop reaches it, or errors if the loop's
    /// queue is gone — it never waits on a fence that was skipped.
    pub(crate) fn enqueue_event_barrier(&self) -> Result<oneshot::Receiver<()>, AcpError> {
        let (barrier, released) = AcpEventBarrier::new();
        if !self
            .inner
            .events
            .send_reliable(AcpEvent::EventBarrier(barrier))
        {
            return Err(AcpError::Protocol(
                "ACP runtime event loop is unavailable".to_string(),
            ));
        }
        Ok(released)
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
        tokio::time::timeout(timeout, self.send_request_until_closed(request))
            .await
            .map_err(|_| AcpError::Timeout(label))?
    }

    /// Request without a deadline, for long-running agent work such as
    /// `session/prompt`. It still settles when the transport closes: on EOF,
    /// on `shutdown()`, or once the process has exited and its pipe drain
    /// grace elapsed — never on wall-clock time alone.
    pub async fn request_until_closed(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, AcpError> {
        let request = UntypedMessage::new(method, params).map_err(AcpError::from_acp)?;
        self.send_request_until_closed(request).await
    }

    async fn send_request_until_closed<Req>(&self, request: Req) -> Result<Req::Response, AcpError>
    where
        Req: JsonRpcRequest,
        Req::Response: Send,
    {
        let label = static_method_label(request.method());
        let mut closed = self.inner.closed.subscribe();
        let pending = self
            .inner
            .connection
            .send_request_to(Agent, request)
            .block_task();
        tokio::select! {
            biased;
            result = pending => result.map_err(AcpError::from_acp),
            _ = closed.wait_for(|closed| *closed) => Err(AcpError::ConnectionClosed(label)),
        }
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

    /// The caller starts stopping the agent (its last requests, then
    /// [`Self::shutdown`]): a transport that breaks from now on, the agent
    /// having exited first, is the expected end and is not reported.
    pub fn begin_close(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
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
        let _cleanup = crate::shared::test_processes::KillOnDrop::default().process(pid as u32);

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

    /// The WARN lines logged on this thread, so by every task of a
    /// current-thread runtime, while the returned guard lives.
    fn capture_warnings() -> (tracing::subscriber::DefaultGuard, impl Fn() -> String) {
        #[derive(Clone, Default)]
        struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Captured {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let guard = tracing::subscriber::set_default(subscriber);
        (guard, move || {
            String::from_utf8(captured.0.lock().unwrap().clone()).unwrap()
        })
    }

    /// An agent that exits while it is being stopped breaks the pipe under
    /// the last notification: the expected end of a deliberate stop. The same
    /// break with no stop under way is still reported.
    #[tokio::test]
    async fn a_pipe_the_agent_breaks_while_stopped_is_not_a_warning() {
        for deliberate in [false, true] {
            let (_guard, warnings) = capture_warnings();
            let (client, _agent_stdout, agent_stdin) = build_in_memory_client().await;
            if deliberate {
                client.begin_close();
            }
            drop(agent_stdin);
            let notification = UntypedMessage::new("session/cancel", json!({"sessionId": "s1"}))
                .expect("test notification method is valid");
            let _ = client.send_notification_typed(notification).await;
            tokio::time::sleep(Duration::from_millis(200)).await;

            assert_eq!(
                warnings().contains("ACP connection closed"),
                !deliberate,
                "deliberate stop: {deliberate}: {}",
                warnings()
            );
        }
    }

    #[tokio::test]
    async fn server_request_seen_only_by_an_observer_is_rejected() {
        // Observers are best-effort and never answer: counting them as a
        // receiver used to leave the agent waiting forever.
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
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
        let rejection = read_frame(&mut agent_stdin).await;
        assert_eq!(rejection["id"], "perm-7");
        assert_eq!(rejection["error"]["code"], -32603);
    }

    #[tokio::test]
    async fn responding_server_request_uses_crate_responder() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe_reliable();
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

    #[tokio::test]
    async fn server_request_ids_preserve_json_types_and_route_out_of_order() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe_reliable();
        let ids = [
            json!(17),
            json!("17"),
            json!(null),
            json!(i64::MIN),
            json!(i64::MAX),
        ];
        for id in &ids {
            write_frame(
                &mut agent_stdout,
                json!({
                    "jsonrpc": "2.0", "id": id, "method": "fs/read_text_file",
                    "params": {"sessionId": "s1", "path": "/tmp/acp-id-test"}
                }),
            )
            .await;
            let event = tokio::time::timeout(Duration::from_secs(1), subscriber.recv())
                .await
                .unwrap()
                .unwrap();
            let AcpEvent::ServerRequest(request) = event else {
                panic!("expected a server request");
            };
            assert_eq!(request.id(), id);
        }
        for id in ids.iter().rev() {
            client
                .respond_server_request(id.clone(), json!({"echo": id}))
                .await
                .unwrap();
            let response = read_frame(&mut agent_stdin).await;
            assert_eq!(&response["id"], id);
            assert_eq!(&response["result"]["echo"], id);
            assert!(client
                .respond_server_request(id.clone(), json!({}))
                .await
                .is_err());
        }
        client.shutdown().await;
    }

    #[tokio::test]
    async fn server_request_without_subscriber_gets_an_error_response() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0", "id": 23, "method": "session/request_permission", "params": {}
            }),
        )
        .await;
        let response = read_frame(&mut agent_stdin).await;
        assert_eq!(response["id"], 23);
        assert_eq!(response["error"]["code"], -32603);
        assert!(response["error"]["data"]
            .as_str()
            .unwrap()
            .contains("no active receiver"));
        assert!(client
            .respond_server_request(json!(23), json!({}))
            .await
            .is_err());
        client.shutdown().await;
    }

    #[tokio::test]
    async fn responses_route_to_their_request_when_received_in_reverse_order() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let first = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("first", json!({}), Duration::from_secs(2))
                    .await
            }
        });
        let first_frame = read_frame(&mut agent_stdin).await;
        let second = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("second", json!({}), Duration::from_secs(2))
                    .await
            }
        });
        let second_frame = read_frame(&mut agent_stdin).await;
        assert_ne!(first_frame["id"], second_frame["id"]);
        for request in [&second_frame, &first_frame] {
            write_frame(
                &mut agent_stdout,
                json!({
                    "jsonrpc": "2.0", "id": request["id"], "result": {"method": request["method"]}
                }),
            )
            .await;
        }
        assert_eq!(first.await.unwrap().unwrap(), json!({"method": "first"}));
        assert_eq!(second.await.unwrap().unwrap(), json!({"method": "second"}));
        client.shutdown().await;
    }

    #[tokio::test]
    async fn agent_eof_settles_pending_request_without_waiting_for_rpc_timeout() {
        let (client, agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let pending = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_with_timeout("session/prompt", json!({}), Duration::from_secs(30))
                    .await
            }
        });
        read_frame(&mut agent_stdin).await;
        drop(agent_stdout);
        let error = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("EOF must fail the request promptly")
            .unwrap()
            .unwrap_err();
        assert!(!matches!(error, AcpError::Timeout(_)));
        client.shutdown().await;
    }

    #[tokio::test]
    async fn untimed_request_settles_when_the_client_shuts_down() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let pending = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_until_closed("session/prompt", json!({}))
                    .await
            }
        });
        read_frame(&mut agent_stdin).await;
        client.shutdown().await;
        let error = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("shutdown must settle an untimed request")
            .unwrap()
            .unwrap_err();
        assert!(!matches!(error, AcpError::Timeout(_)), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn untimed_request_settles_after_exit_even_if_a_descendant_holds_the_pipes() {
        // Without the old one-hour cap, a descendant that inherited stdout
        // (so EOF never arrives) must not keep `session/prompt` pending.
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exec 3<&0; sleep 6 <&3 & exit 0"]);
        let client = AcpClient::spawn(
            AcpSpawnOptions::builder()
                .command(command)
                .client_info(AcpClientInfo::default())
                .build(),
        )
        .await
        .expect("spawn ACP stand-in");
        let mut events = client.subscribe_reliable();
        let pending = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .request_until_closed("session/prompt", json!({}))
                    .await
            }
        });
        let error = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .expect("a dead agent must not leave the prompt pending")
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(error, AcpError::ConnectionClosed("session/prompt")),
            "{error}"
        );
        assert!(matches!(
            events.recv().await,
            Some(AcpEvent::ProcessExited {
                status: Some(0),
                ..
            })
        ));
        client.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_flushes_queued_notification_with_agent_output_still_open() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let notification =
            UntypedMessage::new("session/cancel", json!({"sessionId": "flush"})).unwrap();
        client.send_notification_typed(notification).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), client.shutdown())
            .await
            .expect("shutdown must not wait for remote EOF");
        let frame = read_frame(&mut agent_stdin).await;
        assert_eq!(frame["method"], "session/cancel");
        assert_eq!(frame["params"]["sessionId"], "flush");
        let mut after = String::new();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), agent_stdin.read_line(&mut after))
                .await
                .expect("shutdown must close the write half")
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn incoming_batch_preserves_notifications_and_groups_request_responses() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe_reliable();
        write_frame(
            &mut agent_stdout,
            json!([
                {"jsonrpc": "2.0", "id": 7, "method": "_qa/first", "params": {}},
                {"jsonrpc": "2.0", "method": "session/update", "params": {
                    "sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "batch"}, "_extension": true}
                }},
                {"jsonrpc": "2.0", "id": "7", "method": "_qa/second", "params": {}}
            ]),
        )
        .await;
        for expected in ["first", "notification", "second"] {
            let event = tokio::time::timeout(Duration::from_secs(1), subscriber.recv())
                .await
                .unwrap()
                .unwrap();
            match (expected, event) {
                ("notification", AcpEvent::Notification(notification)) => {
                    assert_eq!(notification.params()["update"]["_extension"], true);
                    assert_eq!(notification.params()["update"]["content"]["text"], "batch");
                }
                (method, AcpEvent::ServerRequest(request)) => {
                    assert_eq!(request.method(), format!("_qa/{method}"));
                }
                _ => panic!("batch dispatch order changed"),
            }
        }
        client
            .reject_server_request(json!("7"), -32601, "unsupported extension")
            .await
            .unwrap();
        client
            .respond_server_request(json!(7), json!({"ok": true}))
            .await
            .unwrap();
        let response = read_frame(&mut agent_stdin).await;
        let responses = response.as_array().expect("batch replies remain grouped");
        assert_eq!(
            responses.len(),
            2,
            "notifications must not produce a response"
        );
        assert!(responses
            .iter()
            .any(|r| r["id"] == json!(7) && r["result"]["ok"] == true));
        assert!(responses
            .iter()
            .any(|r| r["id"] == json!("7") && r["error"]["code"] == -32601));
        client.shutdown().await;
    }

    #[tokio::test]
    async fn initialize_rejects_an_incompatible_protocol_version() {
        use agent_client_protocol::schema::{v1::InitializeRequest, ProtocolVersion};

        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let initialize = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .send_request_typed(
                        InitializeRequest::new(ProtocolVersion::V1),
                        Duration::from_secs(2),
                    )
                    .await
            }
        });
        let request = read_frame(&mut agent_stdin).await;
        assert_eq!(request["params"]["protocolVersion"], 1);
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0", "id": request["id"],
                "result": {"protocolVersion": 99, "agentCapabilities": {}}
            }),
        )
        .await;
        let error = initialize
            .await
            .unwrap()
            .expect_err("v1 client must reject a different wire protocol");
        assert!(!matches!(error, AcpError::Timeout(_)), "{error}");
        assert!(
            error.to_string().to_lowercase().contains("protocol"),
            "{error}"
        );
        client.shutdown().await;
    }

    async fn read_frame(reader: &mut BufReader<tokio::io::DuplexStream>) -> serde_json::Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
            .await
            .expect("agent must receive a frame")
            .unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    async fn write_frame(writer: &mut tokio::io::DuplexStream, value: serde_json::Value) {
        writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }
}
