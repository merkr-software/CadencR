use serde_json::Value;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimePermissionDecision, RuntimePermissionRequest,
};
use crate::domain::mcp::trusted::is_trusted_cadencr_browser_tool_name;

use super::schema_bridge::permission_response_value;

pub async fn try_auto_allow_trusted_cadencr_browser_permission(
    client: &AcpClient,
    raw_id: Value,
    request: &RuntimePermissionRequest,
) -> Result<bool, RuntimeError> {
    if !is_trusted_cadencr_browser_tool_name(&request.tool_name) {
        return Ok(false);
    }
    let Some(option_id) = request
        .options
        .iter()
        .find(|option| option.decision == RuntimePermissionDecision::AllowOnce)
        .and_then(|option| option.option_id.as_deref())
    else {
        return Ok(false);
    };
    let payload =
        permission_response_value(RuntimePermissionDecision::AllowOnce, Some(option_id), None);
    client
        .respond_server_request(raw_id, payload)
        .await
        .map_err(|e| {
            RuntimeError::new(format!(
                "trusted Cadencr browser permission auto-allow failed: {e}"
            ))
        })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    use super::try_auto_allow_trusted_cadencr_browser_permission;
    use crate::domain::agents::acp::{AcpClient, AcpClientInfo, AcpEvent};
    use crate::domain::agents::adapter::{
        RuntimePermissionDecision, RuntimePermissionOption, RuntimePermissionRequest,
    };

    async fn build_in_memory_client() -> (AcpClient, DuplexStream, BufReader<DuplexStream>) {
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

    async fn write_frame(stdout: &mut DuplexStream, value: Value) {
        let mut frame = serde_json::to_vec(&value).unwrap();
        frame.push(b'\n');
        stdout.write_all(&frame).await.unwrap();
    }

    async fn read_frame(reader: &mut BufReader<DuplexStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    #[tokio::test]
    async fn trusted_cadencr_browser_permission_answers_without_prompt_event() {
        let (client, mut agent_stdout, mut agent_stdin) = build_in_memory_client().await;
        let mut subscriber = client.subscribe();
        write_frame(
            &mut agent_stdout,
            json!({
                "jsonrpc": "2.0",
                "id": "perm-browser",
                "method": "session/request_permission",
                "params": {}
            }),
        )
        .await;
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), subscriber.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(event, AcpEvent::ServerRequest(_)));

        let request = RuntimePermissionRequest {
            request_id: "perm-browser".to_string(),
            tool_use_id: Some("call-browser".to_string()),
            tool_name: "mcp__cadencr-browser__browser_open_url".to_string(),
            tool_input: json!({ "url": "http://localhost:1420" }),
            description: None,
            preview: None,
            pattern: None,
            options: vec![RuntimePermissionOption {
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: Some("allow-browser-once".to_string()),
                label: "Allow browser".to_string(),
                description: "Allow trusted browser MCP".to_string(),
                collect_feedback: false,
            }],
        };

        let handled = try_auto_allow_trusted_cadencr_browser_permission(
            &client,
            json!("perm-browser"),
            &request,
        )
        .await
        .unwrap();

        let response = read_frame(&mut agent_stdin).await;
        assert!(handled);
        assert_eq!(response["id"], "perm-browser");
        assert_eq!(
            response["result"]["outcome"]["optionId"],
            "allow-browser-once"
        );
    }
}
