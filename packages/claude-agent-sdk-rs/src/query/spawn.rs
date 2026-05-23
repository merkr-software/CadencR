//! Top-level [`query`] constructor: spawns the Claude CLI subprocess,
//! sends the `initialize` handshake, writes the first user prompt, and
//! starts the background reader task that feeds the [`Query`] stream.

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info};

use crate::discovery::find_cli;
use crate::error::SdkError;
use crate::options::Options;
use crate::transport::CliProcess;

use super::cancelled_control::CancelledControlRequests;
use super::query_struct::Query;
use super::reader::reader_loop;
use super::turn_state::TurnState;
use super::wire::{build_control_request, write_to_stdin, PendingControl};

/// Spawn a Claude CLI query and return a streaming [`Query`] handle.
///
/// The `Query` implements [`Stream<Item = Result<SdkMessage, SdkError>>`].
/// Iterate it with `while let Some(msg) = query.next().await` using
/// [`StreamExt`](futures::StreamExt).
///
/// # Turn management
///
/// - While streaming, [`Query::turn_state()`] is [`TurnState::AgentWorking`]
/// - When a `Result` message arrives, it becomes [`TurnState::TurnComplete`]
/// - When `canUseTool` blocks, it becomes [`TurnState::WaitingForPermission`]
///
/// # Example
///
/// ```no_run
/// use claude_agent_sdk_rs::{query, Options, TurnState};
/// use futures::StreamExt;
///
/// # async fn example() -> Result<(), claude_agent_sdk_rs::SdkError> {
/// let options = Options::default();
/// let mut q = query("Hello Claude".into(), options).await?;
///
/// while let Some(msg) = q.next().await {
///     match msg {
///         Ok(msg) => println!("{msg:?}"),
///         Err(e) => eprintln!("error: {e}"),
///     }
/// }
/// # Ok(())
/// # }
/// ```
pub async fn query(content: serde_json::Value, mut options: Options) -> Result<Query, SdkError> {
    let cli_path = find_cli(options.path_to_cli.as_deref()).await?;
    let configured_mcp_servers =
        crate::mcp_discovery::configured_mcp_servers(&options.cwd, options.mcp_servers.as_ref());
    let configured_mcp_names = configured_mcp_servers
        .iter()
        .map(|server| format!("{}:{}", server.name, server.status))
        .collect::<Vec<_>>();
    debug!(
        cwd = %options.cwd.display(),
        configured_mcp_count = configured_mcp_names.len(),
        configured_mcp_servers = ?configured_mcp_names,
        explicit_mcp_count = options.mcp_servers.as_ref().map_or(0, std::collections::HashMap::len),
        "claude mcp: resolved configured servers before CLI spawn"
    );
    let mut process = CliProcess::spawn(&cli_path, &options).await?;

    // Capture PID before moving process into reader loop.
    let pid = process.pid();
    info!(pid = ?pid, cli = %cli_path.display(), "CLI process spawned");

    // Take stdin out of the process — Query and the reader loop share it
    // via Arc<Mutex<..>> so the reader loop can write permission responses
    // and Query can write user messages / control commands.
    let stdin = process.take_stdin();
    let process_stdin = Arc::new(Mutex::new(stdin));

    // Extract runtime-only fields from options
    let can_use_tool = options.can_use_tool.take();
    let cancel_token = options.abort_signal.take();

    // Set up channel and shared state
    let (tx, rx) = mpsc::channel(256);
    let (interrupt_tx, interrupt_rx) = mpsc::channel(4);
    let (kill_tx, kill_rx) = mpsc::channel(1);
    let session_id = Arc::new(Mutex::new(None));
    let mcp_servers = Arc::new(Mutex::new(Vec::new()));
    let turn_state = Arc::new(Mutex::new(TurnState::AgentWorking));
    let pending_control: PendingControl = Arc::new(Mutex::new(HashMap::new()));
    let cancelled_control_requests = CancelledControlRequests::default();
    let control_request_counter = Arc::new(AtomicU64::new(0));

    // Spawn background reader
    let reader_task = tokio::spawn(reader_loop(
        process,
        Arc::clone(&process_stdin),
        tx,
        can_use_tool,
        Arc::clone(&session_id),
        Arc::clone(&mcp_servers),
        Arc::clone(&turn_state),
        Arc::clone(&pending_control),
        cancelled_control_requests.clone(),
        cancel_token.clone(),
        interrupt_rx,
        kill_rx,
    ));

    let query = Query {
        message_rx: rx,
        process_stdin,
        session_id,
        mcp_servers,
        configured_mcp_servers,
        turn_state,
        pending_control,
        control_request_counter,
        reader_task: Some(reader_task),
        interrupt_tx,
        kill_tx,
        _cancel_token: cancel_token,
        pid,
    };

    send_initialize_and_first_prompt(&query, &options, content).await?;

    Ok(query)
}

async fn send_initialize_and_first_prompt(
    query: &Query,
    options: &Options,
    content: serde_json::Value,
) -> Result<(), SdkError> {
    send_initialize(query, options.system_prompt.as_deref()).await?;
    if query.configured_mcp_servers.is_empty() {
        debug!("claude mcp: skipping pre-prompt mcp_status because no servers are configured");
    } else {
        debug!("claude mcp: querying mcp_status before first user prompt");
        query.preload_mcp_server_status().await;
    }
    send_first_prompt(query, content).await
}

async fn send_initialize(query: &Query, system_prompt: Option<&str>) -> Result<(), SdkError> {
    // Only include `systemPrompt` when the caller actually set one. Sending
    // `"systemPrompt": null` makes the CLI drop its default Claude Code system
    // prompt entirely — the `# Environment` block (model identity, cwd, git)
    // and all the Claude Code agent instructions — leaving the session with an
    // empty system prompt. Omitting the key makes the CLI use its full default
    // preset (the same thing a bare `claude -p` and the metadata probe do).
    let mut init_request = serde_json::json!({ "subtype": "initialize" });
    if let Some(system_prompt) = system_prompt {
        init_request["systemPrompt"] = system_prompt.into();
    }
    let (_init_request_id, init_msg) = build_control_request("init", init_request);
    debug!("sending initialize control_request to CLI stdin");
    write_to_stdin(&query.process_stdin, &init_msg).await
}

async fn send_first_prompt(query: &Query, content: serde_json::Value) -> Result<(), SdkError> {
    let prompt_msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": null,
        "session_id": ""
    });
    write_to_stdin(&query.process_stdin, &prompt_msg).await
}

#[cfg(test)]
mod tests {
    use crate::messages::SdkMessage;
    use crate::options::Options;
    use futures::StreamExt;
    use tempfile::TempDir;

    use super::super::test_support::{mock_mcp_servers, write_mock_cli};
    use super::query;

    #[tokio::test]
    async fn query_sends_initialize_and_skips_control_response() {
        let dir = TempDir::new().unwrap();

        // Mock CLI: read the initialize request, respond with control_response,
        // then read the user prompt, emit system init + result.
        // The control_response should NOT appear as an SDK message.
        let script = r#"#!/bin/sh
read -r INIT_REQ
echo '{"type":"control_response","response":{"subtype":"success","request_id":"init_test","response":{"pid":1234}}}'
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"mcpServers":[]}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_init","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}'
echo '{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_init","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"permission_denials":[],"structured_output":null}'
"#;
        let script_path = write_mock_cli(dir.path(), script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();

        let mut messages = Vec::new();
        while let Some(msg) = q.next().await {
            messages.push(msg.unwrap());
        }

        // control_response should be filtered out — only System(Init) + Result
        assert_eq!(
            messages.len(),
            2,
            "expected 2 messages, got {}",
            messages.len()
        );
        assert!(messages
            .iter()
            .all(|m| !matches!(m, SdkMessage::Unknown(v) if v.get("type").and_then(|t| t.as_str()) == Some("control_response"))));

        let sid = q.session_id().await;
        assert_eq!(sid, Some("sess_init".to_string()));
    }

    #[tokio::test]
    async fn query_writes_image_only_content_without_synthesizing_text() {
        let dir = TempDir::new().unwrap();
        let captured_path = dir.path().join("user_prompt.json");
        let script = format!(
            r#"#!/bin/sh
set -e
CAPTURED='{}'
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
printf '%s' "$USER_PROMPT" > "$CAPTURED"
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_image","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
echo '{{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_image","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"permission_denials":[],"structured_output":null}}'
"#,
            captured_path.display()
        );
        let script_path = write_mock_cli(dir.path(), &script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };
        let content = serde_json::json!([{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "abc"
            }
        }]);

        let mut q = query(content.clone(), options).await.unwrap();
        while q.next().await.is_some() {}

        let captured_raw = std::fs::read_to_string(captured_path).expect("captured prompt");
        let captured: serde_json::Value =
            serde_json::from_str(captured_raw.trim()).expect("captured prompt JSON");
        assert_eq!(captured["message"]["content"], content);
    }

    #[tokio::test]
    async fn query_requests_mcp_status_before_first_user_prompt() {
        let dir = TempDir::new().unwrap();
        let captured_path = dir.path().join("mcp_status_request.json");
        let script = format!(
            r#"#!/bin/sh
set -e
CAPTURED='{}'
read -r INIT_REQ
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r MCP_REQ
printf '%s' "$MCP_REQ" > "$CAPTURED"
MCP_SUBTYPE=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"subtype":"\([^"]*\)".*/\1/p')
test "$MCP_SUBTYPE" = "mcp_status"
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[{{"name":"chrome-devtools","status":"pending"}}]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_boot_mcp","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
echo '{{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_boot_mcp","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"permission_denials":[],"structured_output":null}}'
"#,
            captured_path.display()
        );
        let script_path = write_mock_cli(dir.path(), &script);

        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            ..Options::default()
        };

        let mut q = query(serde_json::Value::String("test".into()), options)
            .await
            .unwrap();
        while q.next().await.is_some() {}

        let captured_raw = std::fs::read_to_string(captured_path).expect("captured MCP request");
        let captured: serde_json::Value =
            serde_json::from_str(captured_raw.trim()).expect("captured MCP request JSON");
        assert_eq!(captured["request"]["subtype"], "mcp_status");
    }

    /// Mock CLI that records the first stdin line (the `initialize`
    /// control_request) to `captured`, then completes a trivial turn so
    /// `query()` returns.
    fn init_capture_script(captured: &std::path::Path) -> String {
        format!(
            r#"#!/bin/sh
set -e
CAP='{}'
read -r INIT_REQ
printf '%s' "$INIT_REQ" > "$CAP"
INIT_ID=$(printf '%s' "$INIT_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{}}}}}}\n' "$INIT_ID"
read -r MCP_REQ
MCP_ID=$(printf '%s' "$MCP_REQ" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"mcpServers":[]}}}}}}\n' "$MCP_ID"
read -r USER_PROMPT
echo '{{"type":"system","subtype":"init","uuid":"u1","session_id":"s","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"m","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}'
echo '{{"type":"result","subtype":"success","uuid":"u2","session_id":"s","duration_ms":1,"duration_api_ms":1,"is_error":false,"num_turns":1,"result":"ok","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"permission_denials":[],"structured_output":null}}'
"#,
            captured.display()
        )
    }

    async fn capture_initialize_request(system_prompt: Option<String>) -> serde_json::Value {
        let dir = TempDir::new().unwrap();
        let captured = dir.path().join("init.json");
        let script_path = write_mock_cli(dir.path(), &init_capture_script(&captured));
        let options = Options {
            path_to_cli: Some(script_path),
            mcp_servers: Some(mock_mcp_servers()),
            system_prompt,
            ..Options::default()
        };
        let mut q = query(serde_json::Value::String("hi".into()), options)
            .await
            .unwrap();
        while q.next().await.is_some() {}
        let raw = std::fs::read_to_string(&captured).expect("captured initialize request");
        serde_json::from_str(raw.trim()).expect("initialize request JSON")
    }

    /// Regression: `systemPrompt: null` makes the CLI drop its default Claude
    /// Code system prompt, so when no custom prompt is set the key must be
    /// omitted entirely (CLI then uses its full default preset).
    #[tokio::test]
    async fn initialize_omits_system_prompt_when_unset() {
        let req = capture_initialize_request(None).await;
        assert_eq!(req["request"]["subtype"], "initialize");
        assert!(
            req["request"].get("systemPrompt").is_none(),
            "systemPrompt must be omitted when unset, got: {req}"
        );
    }

    #[tokio::test]
    async fn initialize_includes_system_prompt_when_set() {
        let req = capture_initialize_request(Some("custom prompt".to_string())).await;
        assert_eq!(req["request"]["subtype"], "initialize");
        assert_eq!(req["request"]["systemPrompt"], "custom prompt");
    }
}
