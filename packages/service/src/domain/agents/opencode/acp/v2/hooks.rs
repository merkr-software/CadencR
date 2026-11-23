//! Runtime hooks for OpenCode 2.x.
//!
//! The wire ([`super::wire`]) already turns 2.x's questions, sub-agents and
//! detached replies into standard ACP, so these hooks keep only what the 1.x
//! adapter shares with them: tool and MCP name normalization, mode and config
//! ids, usage, MCP status, browser trust, slash-command snapshots and the
//! session move before a resume. Nothing here talks to an HTTP side channel.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use opencode_sdk_rs::StandaloneApi;
use serde_json::Value;
use tempfile::TempDir;

use super::super::adapter_normalize::{normalize_edit_input, normalize_tool_name, opencode_mode};
use super::super::browser_trust::opencode_browser_trust;
use super::super::mcp_status::opencode_mcp_statuses;
use super::super::prompt_usage::prompt_response_usage;
use super::super::resolved_mcp::ResolvedMcpConfig;
use super::super::tool_result_flatten::flatten_tool_result_content;
use crate::domain::agents::acp::runtime::provider_hooks::AcpProviderHooks;
use crate::domain::agents::adapter::{
    RuntimeError, RuntimeMcpServerStatus, RuntimePermissionMode, RuntimeSlashCommand, RuntimeUsage,
};
use crate::domain::agents::mcp_tool_names::McpToolNameResolver;
use crate::domain::mcp::trusted::CadencrBrowserTrust;

pub(super) struct OpenCodeV2Hooks {
    binary: PathBuf,
    /// Optional Cadencr instructions file, kept alive for the process lifetime.
    _instructions_dir: Option<TempDir>,
    mcp_tool_names: McpToolNameResolver,
    resolved_mcp: ResolvedMcpConfig,
}

impl OpenCodeV2Hooks {
    pub(super) fn new(binary: PathBuf, instructions_dir: Option<TempDir>) -> Self {
        Self {
            binary,
            _instructions_dir: instructions_dir,
            mcp_tool_names: McpToolNameResolver::default(),
            resolved_mcp: ResolvedMcpConfig::default(),
        }
    }
}

#[async_trait]
impl AcpProviderHooks for OpenCodeV2Hooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        normalize_tool_name(&self.mcp_tool_names, raw)
    }

    fn normalize_tool_input(&self, tool_name: &str, input: Value) -> Value {
        normalize_edit_input(tool_name, input)
    }

    fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
        flatten_tool_result_content(blocks)
    }

    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String> {
        Some(opencode_mode(mode))
    }

    fn model_config_id(&self) -> Option<&str> {
        Some("model")
    }

    fn thinking_effort_config_id(&self) -> Option<String> {
        Some("effort".to_string())
    }

    fn default_mode_id(&self) -> Option<&'static str> {
        Some("build")
    }

    fn compact_prompt(&self) -> Option<String> {
        Some("/compact".to_string())
    }

    fn prompt_response_usage(&self, response: &Value) -> Option<RuntimeUsage> {
        prompt_response_usage(response)
    }

    async fn available_mcp_servers(
        &self,
        cwd: &Path,
        configured: Vec<RuntimeMcpServerStatus>,
    ) -> Vec<RuntimeMcpServerStatus> {
        let listed = self.resolved_mcp.servers(cwd).await;
        opencode_mcp_statuses(
            listed.as_ref().map(|servers| servers.iter()),
            configured,
            &self.mcp_tool_names,
        )
    }

    fn supports_durable_resume(&self) -> bool {
        true
    }

    async fn before_session_resume(
        &self,
        session_id: &str,
        cwd: &Path,
    ) -> Result<(), RuntimeError> {
        let api = StandaloneApi::new(self.binary.clone(), Some(cwd.to_path_buf()));
        super::session_location::follow_session_to(&api, session_id, cwd).await
    }

    /// The launch acknowledgement of a background sub-agent is noise; its
    /// result arrives as the run's summary.
    fn suppresses_raw_output(&self, tool_name: &str) -> bool {
        matches!(tool_name, "Task" | "Agent")
    }

    async fn cadencr_browser_trust(
        &self,
        cwd: &Path,
        injected: CadencrBrowserTrust,
    ) -> CadencrBrowserTrust {
        if !injected.is_trusted() {
            return injected;
        }
        opencode_browser_trust(injected, self.resolved_mcp.servers(cwd).await)
    }

    async fn record_available_commands(&self, cwd: &Path, commands: Vec<RuntimeSlashCommand>) {
        let cwd = cwd.to_string_lossy().into_owned();
        crate::domain::agents::opencode::commands::record_snapshot(&cwd, commands).await;
    }
}
