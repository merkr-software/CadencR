//! ACP `initialize` + `session/new`/`session/load` handshake.
//!
//! Returns a `NegotiatedSession` describing the live session id, the model
//! string the agent claims to be using (when available), advertised modes,
//! configured MCP servers, and any context-window hint we could recover.
//!
//! ACP version drift is handled defensively: if a caller asks to resume a
//! session, the agent must advertise `loadSession` and successfully answer
//! `session/load`. We never fall back to `session/new` for a requested
//! resume because that would silently create a fresh conversation.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ClientCapabilities, FileSystemCapabilities, Implementation, InitializeRequest,
    LoadSessionRequest, McpServer, NewSessionRequest,
};
use agent_client_protocol::schema::ProtocolVersion;
use serde_json::Value;

use super::provider_hooks::AcpProviderHooks;
use crate::domain::agents::acp::runtime::mcp::build_stdio_mcp_payload;
use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeMcpServerConfig, RuntimeMcpServerStatus, RuntimeSpawnConfig,
};

const INIT_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_SETUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct NegotiatedSession {
    pub session_id: String,
    pub model: Option<String>,
    pub mcp_servers: Vec<RuntimeMcpServerStatus>,
    pub context_window: Option<u64>,
    /// `currentModeId` reported by the agent in `session/new`, when it
    /// advertises one. `None` if the agent omits modes from the response.
    pub current_mode: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct AgentCapabilities {
    pub load_session: bool,
}

/// Run the full handshake. Returns the `NegotiatedSession` or a
/// `RuntimeError` if any step fails fatally (initialize timed out / agent
/// hung up). When a resume id is present, unsupported resume is fatal so the
/// runtime never silently replaces an existing conversation with a fresh one.
///
/// `context_window` is provider-resolved: the caller (an adapter) maps the
/// model id → window using its provider catalog before invoking us.
pub async fn negotiate_session(
    client: &AcpClient,
    config: &RuntimeSpawnConfig,
    context_window: Option<u64>,
    hooks: &dyn AcpProviderHooks,
) -> Result<NegotiatedSession, RuntimeError> {
    let init_result = client
        .send_request_typed(initialize_request(client), INIT_TIMEOUT)
        .await
        .map_err(|e| RuntimeError::new(format!("ACP initialize failed: {e}")))?;
    let init_value = serde_json::to_value(init_result)
        .map_err(|e| RuntimeError::new(format!("ACP initialize response invalid: {e}")))?;
    let capabilities = parse_agent_capabilities(&init_value);

    let resume_id = config.resume_session_id.as_deref();
    if let Some(resume_id) = resume_id {
        let provider_supports_resume = hooks.supports_durable_resume();
        if !provider_supports_resume || !capabilities.load_session {
            let reason = if provider_supports_resume {
                "agent does not advertise session/load support"
            } else {
                "provider does not support durable ACP resume"
            };
            tracing::warn!(
                advertised_load_session = capabilities.load_session,
                provider_supports_resume,
                reason,
                "refusing to start fresh ACP session when resume_session_id was requested"
            );
            return Err(RuntimeError::new(format!(
                "cannot resume ACP session {resume_id}: {reason}"
            )));
        }
    }

    let model_id = config.model.clone();
    let mcp_servers = build_stdio_mcp_payload(config.mcp_servers.as_ref());
    let mcp_statuses = hooks
        .available_mcp_servers(&config.cwd, mcp_status_list(config.mcp_servers.as_ref()))
        .await;
    if let Some(resume_id) = resume_id {
        let current_mode = load_session(client, resume_id, &config.cwd, &mcp_servers).await?;
        return Ok(NegotiatedSession {
            session_id: resume_id.to_string(),
            model: model_id,
            mcp_servers: mcp_statuses,
            context_window,
            current_mode,
        });
    }
    let (session_id, current_mode) = start_new_session(client, &config.cwd, &mcp_servers).await?;

    Ok(NegotiatedSession {
        session_id,
        model: model_id,
        mcp_servers: mcp_statuses,
        context_window,
        current_mode,
    })
}

async fn load_session(
    client: &AcpClient,
    session_id: &str,
    cwd: &Path,
    mcp_servers: &Value,
) -> Result<Option<String>, RuntimeError> {
    let request = LoadSessionRequest::new(session_id.to_string(), cwd.to_path_buf()).mcp_servers(
        serde_json::from_value::<Vec<McpServer>>(mcp_servers.clone())
            .map_err(|e| RuntimeError::new(format!("ACP MCP server config invalid: {e}")))?,
    );
    let result = client
        .send_request_typed(request, SESSION_SETUP_TIMEOUT)
        .await
        .map_err(|e| RuntimeError::new(format!("ACP session/load failed: {e}")))?;
    Ok(result
        .modes
        .as_ref()
        .map(|modes| modes.current_mode_id.to_string()))
}

fn initialize_request(client: &AcpClient) -> InitializeRequest {
    let info = client.client_info();
    InitializeRequest::new(ProtocolVersion::V1)
        .client_capabilities(
            ClientCapabilities::new()
                .fs(FileSystemCapabilities::new()
                    .read_text_file(true)
                    .write_text_file(true))
                .terminal(true),
        )
        .client_info(
            Implementation::new(info.name.clone(), info.version.clone())
                .title(Some(info.title.clone())),
        )
}

fn parse_agent_capabilities(init_response: &Value) -> AgentCapabilities {
    let load_session = init_response
        .get("agentCapabilities")
        .and_then(|caps| caps.get("loadSession"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    AgentCapabilities { load_session }
}

async fn start_new_session(
    client: &AcpClient,
    cwd: &Path,
    mcp_servers: &Value,
) -> Result<(String, Option<String>), RuntimeError> {
    let request = NewSessionRequest::new(cwd.to_path_buf()).mcp_servers(
        serde_json::from_value::<Vec<McpServer>>(mcp_servers.clone())
            .map_err(|e| RuntimeError::new(format!("ACP MCP server config invalid: {e}")))?,
    );
    let result = client
        .send_request_typed(request, SESSION_SETUP_TIMEOUT)
        .await
        .map_err(|e| RuntimeError::new(format!("ACP session/new failed: {e}")))?;
    let current_mode = result
        .modes
        .as_ref()
        .map(|modes| modes.current_mode_id.to_string());
    Ok((result.session_id.to_string(), current_mode))
}

/// Extract `modes.currentModeId` from a `session/new` response, or `None`
/// when the agent omits it.
#[cfg(test)]
fn extract_current_mode(value: &Value) -> Option<String> {
    value
        .get("modes")
        .and_then(|m| m.get("currentModeId"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

/// Synthesise an MCP server status list for the init event.
///
/// ACP `session/new` accepts an MCP server catalog but does not prove that
/// every configured server has spawned and passed a health check. Reporting
/// `connected` here would make the spec status field a lie, so keep the
/// status explicitly unknown until a future health probe can replace it with
/// an observed state.
fn mcp_status_list(
    servers: Option<&HashMap<String, RuntimeMcpServerConfig>>,
) -> Vec<RuntimeMcpServerStatus> {
    servers
        .map(|m| {
            m.keys()
                .map(|name| RuntimeMcpServerStatus {
                    name: name.clone(),
                    status: "unknown".to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        extract_current_mode, mcp_status_list, negotiate_session, parse_agent_capabilities,
        AgentCapabilities, NegotiatedSession,
    };
    use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
    use crate::domain::agents::acp::runtime::test_support::{
        build_in_memory_client, read_request, send_response,
    };
    use crate::domain::agents::adapter::{
        RuntimeError, RuntimeMcpServerConfig, RuntimePermissionMode, RuntimeSpawnConfig,
    };
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::time::Duration;
    use tokio::task::JoinHandle;

    const RESUME_ID: &str = "ses_existing";
    const RESUME_TEST_TIMEOUT: Duration = Duration::from_secs(1);

    struct ResumeHooks;

    #[async_trait::async_trait]
    impl AcpProviderHooks for ResumeHooks {
        fn normalize_tool_name(&self, raw: &str) -> String {
            raw.to_string()
        }

        fn normalize_tool_input(&self, _: &str, input: Value) -> Value {
            input
        }

        fn mode_for_permission_mode(&self, _: RuntimePermissionMode) -> Option<String> {
            Some("build".to_string())
        }

        fn supports_durable_resume(&self) -> bool {
            true
        }
    }

    fn resume_config() -> RuntimeSpawnConfig {
        RuntimeSpawnConfig {
            cwd: std::env::temp_dir().join("cadencr-acp-resume-test"),
            resume_session_id: Some(RESUME_ID.to_string()),
            ..RuntimeSpawnConfig::default()
        }
    }

    async fn await_negotiation(
        task: &mut JoinHandle<Result<NegotiatedSession, RuntimeError>>,
    ) -> Result<NegotiatedSession, RuntimeError> {
        match tokio::time::timeout(RESUME_TEST_TIMEOUT, &mut *task).await {
            Ok(result) => result.expect("negotiation task should not panic"),
            Err(_) => {
                task.abort();
                panic!("resume negotiation timed out, likely waiting on an unexpected fallback request");
            }
        }
    }

    #[tokio::test]
    async fn resume_without_agent_load_capability_errors_instead_of_starting_fresh() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let config = resume_config();
        let mut task =
            tokio::spawn(
                async move { negotiate_session(&client, &config, None, &ResumeHooks).await },
            );

        let init = read_request(&mut stdin).await;
        assert_eq!(init["method"], "initialize");
        send_response(
            &mut stdout,
            init["id"].clone(),
            json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": false } }),
        )
        .await;

        let error = await_negotiation(&mut task)
            .await
            .expect_err("resume without loadSession must fail");
        assert!(error.to_string().contains("cannot resume ACP session"));
    }

    #[tokio::test]
    async fn resume_with_load_capability_uses_session_load() {
        let (client, mut stdout, mut stdin) = build_in_memory_client().await;
        let config = resume_config();
        let mut task =
            tokio::spawn(
                async move { negotiate_session(&client, &config, None, &ResumeHooks).await },
            );

        let init = read_request(&mut stdin).await;
        send_response(
            &mut stdout,
            init["id"].clone(),
            json!({ "protocolVersion": 1, "agentCapabilities": { "loadSession": true } }),
        )
        .await;
        let load = read_request(&mut stdin).await;
        assert_eq!(load["method"], "session/load");
        assert_eq!(load["params"]["sessionId"], RESUME_ID);
        send_response(
            &mut stdout,
            load["id"].clone(),
            json!({ "modes": { "currentModeId": "build", "availableModes": [] } }),
        )
        .await;

        let negotiated = await_negotiation(&mut task).await.unwrap();
        assert_eq!(negotiated.session_id, RESUME_ID);
        assert_eq!(negotiated.current_mode.as_deref(), Some("build"));
    }

    #[test]
    fn parse_capabilities_recognises_load_session_flag() {
        let caps = parse_agent_capabilities(&json!({
            "agentCapabilities": { "loadSession": true }
        }));
        assert!(caps.load_session);
    }

    #[test]
    fn parse_capabilities_defaults_load_session_false() {
        let caps = parse_agent_capabilities(&json!({}));
        assert!(!caps.load_session);
    }

    #[test]
    fn mcp_status_list_marks_servers_unknown_until_health_probe_exists() {
        let mut servers = HashMap::new();
        servers.insert(
            "tools".to_string(),
            RuntimeMcpServerConfig::Stdio {
                command: "x".to_string(),
                args: None,
                env: None,
            },
        );
        let statuses = mcp_status_list(Some(&servers));
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].name, "tools");
        assert_eq!(statuses[0].status, "unknown");
    }

    #[test]
    fn agent_capabilities_default_is_none() {
        let caps = AgentCapabilities::default();
        assert!(!caps.load_session);
    }

    #[test]
    fn extract_current_mode_reads_modes_namespace() {
        let mode = extract_current_mode(&json!({
            "sessionId": "s-1",
            "modes": { "currentModeId": "plan" }
        }));
        assert_eq!(mode.as_deref(), Some("plan"));
    }

    #[test]
    fn extract_current_mode_returns_none_when_absent() {
        let mode = extract_current_mode(&json!({ "sessionId": "s-1" }));
        assert!(mode.is_none());
    }
}
