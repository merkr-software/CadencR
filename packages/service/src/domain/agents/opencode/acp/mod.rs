//! OpenCode adapter on top of the generic ACP transport.
//!
//! Owns OpenCode-specific spawn (`opencode acp --cwd <cwd>`), the question
//! sidecar (used by OpenCode's interactive `question` tool), and the
//! `OpenCodeAcpAdapter` that plugs OpenCode quirks into the otherwise
//! provider-neutral `acp::runtime` layer.

mod adapter;
mod adapter_normalize;
mod events_subagent_synthesis;
mod events_tool_call_question;
mod instructions;
mod mcp_status;
mod permission_reply;
pub(in crate::domain::agents) mod port;
mod prompt_usage;
mod question_sidecar;
mod tool_result_flatten;
// Workarounds for ACP-wire limitations in upstream OpenCode. Anything
// that talks to the embedded HTTP backend on `--port` to make up for an
// ACP-wire gap lives here; see `upstream_workaround/mod.rs` for the
// removal criteria. Distinct from the removed legacy OpenCode long-lived transport;
// do not remove this workaround directory just because the old transport is gone.
mod upstream_workaround;

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::domain::agents::acp::runtime::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::{AcpClient, AcpClientInfo, AcpSpawnOptions};
use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeError, RuntimeSpawnConfig};

use self::adapter::OpenCodeAcpAdapter;
use self::instructions::apply_instruction_config;
use self::port::reserve_local_port;
use self::question_sidecar::QuestionSidecar;

/// ACP's answer to the runtime layer's "is this session finished?" probe.
///
/// The removed long-lived transport answered by walking OpenCode's persisted
/// message log for a terminal stop reason. For ACP the runtime is the
/// `opencode acp` subprocess that *we* own, and a finished agent turn is
/// not the same as a finished session: the subprocess stays alive across
/// turns so follow-up prompts share an ACP `sessionId` and the agent keeps
/// conversation memory. Real subprocess exit is signalled separately
/// through `AcpEvent::ProcessExited`, which the event loop converts into
/// an `Err` on the runtime channel and the WS stream reader breaks on
/// that path. So the answer here is unconditionally `false`.
pub(super) async fn session_finished(_runtime_session_id: &str) -> bool {
    false
}

pub(in crate::domain::agents::opencode) fn acp_command(
    binary: &Path,
    cwd: &OsStr,
    port: u16,
) -> tokio::process::Command {
    cli_discovery::login_shell_exec_command(
        binary.as_os_str(),
        [
            OsString::from("acp"),
            OsString::from("--cwd"),
            cwd.to_os_string(),
            OsString::from("--hostname"),
            OsString::from("127.0.0.1"),
            OsString::from("--port"),
            OsString::from(port.to_string()),
        ],
    )
}

pub(in crate::domain::agents::opencode) async fn spawn_headless_acp(
    cwd: &OsStr,
) -> Result<(AcpClient, u16), RuntimeError> {
    let port_reservation = reserve_local_port()?;
    let port = port_reservation.port();
    let binary = opencode_sdk_rs::process::resolve_binary().await?;
    let mut command = acp_command(&binary, cwd, port);
    command.env("OPENCODE_ENABLE_QUESTION_TOOL", "0");

    let client = AcpClient::spawn(AcpSpawnOptions {
        command,
        client_info: AcpClientInfo::default(),
        max_line_bytes: None,
        spawn_guard: Some(Box::new(port_reservation)),
    })
    .await
    .map_err(|error| RuntimeError::new(error.to_string()))?;
    Ok((client, port))
}

/// Entry point invoked by `OpenCodeAdapter::spawn`. ACP is the only
/// supported OpenCode transport.
pub(super) async fn spawn_acp_session(
    content: Value,
    mut config: RuntimeSpawnConfig,
) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
    let binary = opencode_sdk_rs::process::resolve_binary().await?;
    let reserved_question_port = reserve_local_port()?;
    let question_port = reserved_question_port.port();
    let instructions_dir = apply_instruction_config(&mut config)?;
    let mut command = acp_command(&binary, config.cwd.as_os_str(), question_port);
    // Opt into OpenCode's interactive `question` tool. Disabled by default
    // in ACP mode (PR opencode#11379) because some clients can't render
    // multi-option prompts. Cadencr DOES — we route the tool_call through
    // the OpenCode adapter's question hook and reply through the same ACP
    // sidecar's scoped question endpoint. Caller env wins.
    let caller_overrides_question_tool = config
        .env
        .as_ref()
        .map(|env| env.contains_key("OPENCODE_ENABLE_QUESTION_TOOL"))
        .unwrap_or(false);
    if !caller_overrides_question_tool {
        command.env("OPENCODE_ENABLE_QUESTION_TOOL", "1");
    }
    if let Some(env) = config.env.as_ref() {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let question_sidecar =
        QuestionSidecar::new(question_port, &config.cwd).with_instructions_dir(instructions_dir);
    let context_window = match config.model.as_deref() {
        Some(model) => {
            crate::domain::agents::providers::opencode::context_window_for_model(model).await
        }
        None => None,
    };
    // `question_port` is also the OpenCode HTTP backend's port — the same
    // server hosts both the question sidecar endpoints and polling endpoints. See
    // `opencode/src/cli/cmd/acp.ts` upstream: `Server.listen({hostname,port})`
    // is bound to the same `--hostname --port` flags Cadencr passes.
    let hooks = Arc::new(OpenCodeAcpAdapter::new(
        question_sidecar,
        question_port,
        &config.cwd,
    ));
    spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
        command,
        spawn_guard: Some(Box::new(reserved_question_port)),
        client_info: AcpClientInfo::default(),
        config,
        initial_content: content,
        context_window,
        hooks,
    })
    .await
}
