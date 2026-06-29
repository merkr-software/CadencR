use super::capability_probe::{request_optional_method, ProbeResult};
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::RuntimeError;
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
const SET_CONFIG_OPTION_TIMEOUT: Duration = Duration::from_secs(15);
pub async fn set_config_option_model(
    client: &AcpClient,
    session_id: &str,
    current_model: &Arc<RwLock<Option<String>>>,
    supports_flag: &Arc<AtomicBool>,
    config_id: Option<&str>,
    new_model: &str,
) -> Result<(), RuntimeError> {
    let Some(config_id) = config_id else {
        set_local_config_value(current_model, Some(new_model)).await;
        return Ok(());
    };
    set_config_option(
        client,
        session_id,
        current_model,
        supports_flag,
        config_id,
        Some(new_model),
    )
    .await
}
pub async fn set_config_option_thinking_effort(
    client: &AcpClient,
    session_id: &str,
    current_effort: &Arc<RwLock<Option<String>>>,
    supports_flag: &Arc<AtomicBool>,
    config_id: Option<&str>,
    new_effort: Option<&str>,
) -> Result<(), RuntimeError> {
    let Some(config_id) = config_id else {
        set_local_config_value(current_effort, new_effort).await;
        return Ok(());
    };
    set_config_option(
        client,
        session_id,
        current_effort,
        supports_flag,
        config_id,
        new_effort,
    )
    .await
}
async fn set_config_option(
    client: &AcpClient,
    session_id: &str,
    current: &Arc<RwLock<Option<String>>>,
    supports_flag: &Arc<AtomicBool>,
    config_id: &str,
    new_value: Option<&str>,
) -> Result<(), RuntimeError> {
    if value_is_already_current(current, new_value).await {
        return Ok(());
    }
    send_set_config_option(client, session_id, supports_flag, config_id, new_value).await?;
    *current.write().await = new_value.map(ToOwned::to_owned);
    Ok(())
}
async fn send_set_config_option(
    client: &AcpClient,
    session_id: &str,
    supports_flag: &Arc<AtomicBool>,
    config_id: &str,
    value: Option<&str>,
) -> Result<(), RuntimeError> {
    let value_payload = value.map_or(Value::Null, |v| Value::String(v.to_string()));
    let params = json!({
        "sessionId": session_id,
        "configId": config_id,
        "type": "string",
        "value": value_payload,
    });
    match request_optional_method(
        client,
        "session/set_config_option",
        params,
        SET_CONFIG_OPTION_TIMEOUT,
        supports_flag,
    )
    .await?
    {
        ProbeResult::Supported | ProbeResult::AlreadyUnsupported => Ok(()),
        ProbeResult::NewlyUnsupported => {
            tracing::warn!(
                config_id,
                "ACP agent does not support session/set_config_option; \
                 falling back to legacy ride-along on session/prompt"
            );
            Ok(())
        }
    }
}
async fn value_is_already_current(
    current: &Arc<RwLock<Option<String>>>,
    new_value: Option<&str>,
) -> bool {
    current.read().await.as_deref() == new_value
}
async fn set_local_config_value(current: &Arc<RwLock<Option<String>>>, new_value: Option<&str>) {
    if value_is_already_current(current, new_value).await {
        return;
    }
    *current.write().await = new_value.map(ToOwned::to_owned);
}
#[cfg(test)]
mod tests {
    use super::{set_config_option_model, set_config_option_thinking_effort};
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo};
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::RwLock;
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
    async fn read_one_request(reader: &mut BufReader<tokio::io::DuplexStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }
    async fn reply_ok(stdout: &mut tokio::io::DuplexStream, id: Value, result: Value) {
        let frame = format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "id": id, "result": result })
        );
        stdout.write_all(frame.as_bytes()).await.unwrap();
    }
    async fn reply_error(
        stdout: &mut tokio::io::DuplexStream,
        id: Value,
        code: i64,
        message: &str,
    ) {
        let frame = format!(
            "{}\n",
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message }
            })
        );
        stdout.write_all(frame.as_bytes()).await.unwrap();
    }
    #[tokio::test]
    async fn wire_payload_uses_top_level_config_id_type_value_no_envelope() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn({
            let client = client.clone();
            let current_model = Arc::clone(&current_model);
            let supports = Arc::clone(&supports);
            async move {
                set_config_option_model(
                    &client,
                    "s-x",
                    &current_model,
                    &supports,
                    Some("model"),
                    "openai/gpt-5.4",
                )
                .await
            }
        });
        let parsed = read_one_request(&mut agent_stdin).await;
        let params = &parsed["params"];
        assert!(
            params.get("configOption").is_none(),
            "must NOT nest under a configOption envelope (OpenCode rejects it)"
        );
        assert_eq!(params["configId"], "model");
        assert_eq!(params["type"], "string");
        assert_eq!(params["value"], "openai/gpt-5.4");
        let id = parsed["id"].clone();
        reply_ok(&mut agent_stdout, id, json!({})).await;
        task.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn set_model_issues_set_config_option_and_updates_state() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(Some("old-model".to_string())));
        let supports = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn({
            let client = client.clone();
            let current_model = Arc::clone(&current_model);
            let supports = Arc::clone(&supports);
            async move {
                set_config_option_model(
                    &client,
                    "s-1",
                    &current_model,
                    &supports,
                    Some("model"),
                    "new-model",
                )
                .await
            }
        });
        let parsed = read_one_request(&mut agent_stdin).await;
        assert_eq!(parsed["method"], "session/set_config_option");
        assert_eq!(parsed["params"]["sessionId"], "s-1");
        assert_eq!(parsed["params"]["configId"], "model");
        assert_eq!(parsed["params"]["type"], "string");
        assert_eq!(parsed["params"]["value"], "new-model");
        let id = parsed["id"].clone();
        reply_ok(&mut agent_stdout, id, json!({})).await;
        task.await.unwrap().unwrap();
        assert_eq!(
            current_model.read().await.as_deref(),
            Some("new-model"),
            "current_model should update on success"
        );
        assert!(
            supports.load(Ordering::SeqCst),
            "supports flag stays true on success"
        );
    }
    #[tokio::test]
    async fn method_not_found_flips_supports_flag_and_returns_ok() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(Some("old-model".to_string())));
        let supports = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn({
            let client = client.clone();
            let current_model = Arc::clone(&current_model);
            let supports = Arc::clone(&supports);
            async move {
                set_config_option_model(
                    &client,
                    "s-1",
                    &current_model,
                    &supports,
                    Some("model"),
                    "new-model",
                )
                .await
            }
        });
        let parsed = read_one_request(&mut agent_stdin).await;
        let id = parsed["id"].clone();
        reply_error(&mut agent_stdout, id, -32601, "method not found").await;
        task.await.unwrap().expect("MethodNotFound is not an error");
        assert!(
            !supports.load(Ordering::SeqCst),
            "supports flag should flip to false"
        );
        assert_eq!(
            current_model.read().await.as_deref(),
            Some("new-model"),
            "local state still updates so the legacy fallback can carry it"
        );
    }
    #[tokio::test]
    async fn already_current_short_circuits_without_request() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_model = Arc::new(RwLock::new(Some("same-model".to_string())));
        let supports = Arc::new(AtomicBool::new(true));
        set_config_option_model(
            &client,
            "s-1",
            &current_model,
            &supports,
            Some("model"),
            "same-model",
        )
        .await
        .unwrap();
        let mut buf = String::new();
        let read_result =
            tokio::time::timeout(Duration::from_millis(50), agent_stdin.read_line(&mut buf)).await;
        assert!(
            read_result.is_err(),
            "no-op set should not emit a request, got: {buf}"
        );
    }
    #[tokio::test]
    async fn supports_false_skips_round_trip_but_still_updates_state() {
        let (client, _agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_effort = Arc::new(RwLock::new(Some("low".to_string())));
        let supports = Arc::new(AtomicBool::new(false));
        set_config_option_thinking_effort(
            &client,
            "s-1",
            &current_effort,
            &supports,
            Some("effort"),
            Some("high"),
        )
        .await
        .unwrap();
        assert_eq!(current_effort.read().await.as_deref(), Some("high"));
        let mut buf = String::new();
        let read_result =
            tokio::time::timeout(Duration::from_millis(50), agent_stdin.read_line(&mut buf)).await;
        assert!(read_result.is_err(), "should not have written a frame");
    }
    #[tokio::test]
    async fn set_thinking_effort_carries_value_under_thinking_effort_name() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let current_effort = Arc::new(RwLock::new(None));
        let supports = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn({
            let client = client.clone();
            let current_effort = Arc::clone(&current_effort);
            let supports = Arc::clone(&supports);
            async move {
                set_config_option_thinking_effort(
                    &client,
                    "s-1",
                    &current_effort,
                    &supports,
                    Some("effort"),
                    Some("high"),
                )
                .await
            }
        });
        let parsed = read_one_request(&mut agent_stdin).await;
        assert_eq!(parsed["params"]["configId"], "effort");
        assert_eq!(parsed["params"]["type"], "string");
        assert_eq!(parsed["params"]["value"], "high");
        let id = parsed["id"].clone();
        reply_ok(&mut agent_stdout, id, json!({})).await;
        task.await.unwrap().unwrap();
        assert_eq!(current_effort.read().await.as_deref(), Some("high"));
    }
}
