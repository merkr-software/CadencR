//! Starting the Claude Code CLI for a runtime spawn.

use serde_json::Value;

use super::cli_processes::CliProcesses;
use super::prompt_receipts::ClaudePromptReceipts;
use super::session::{
    map_mcp_server_config, map_permission_mode, ClaudeCanUseToolAdapter, ClaudeCodeSession,
};
use super::ClaudeCodeAdapter;
use crate::domain::agents::adapter::{AgentRuntimeSession, RuntimeError, RuntimeSpawnConfig};

impl ClaudeCodeAdapter {
    pub(super) async fn spawn_session(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        // Resolve a stored bare alias (sonnet/opus/haiku) to the concrete model
        // the active profile's catalog advertises. Under Bedrock/Vertex the
        // bare alias is pinned by the CLI to a legacy version (e.g. `sonnet` →
        // Sonnet 4.5), while the catalog/picker uses concrete ids. Probing with
        // `config.env` (the active profile env) hits the same cache key the
        // settings catalog populated, so this is a cache read in the common
        // case. No-op under the default Anthropic backend, where the alias is
        // itself the catalog id.
        let model = match config.model {
            Some(requested) => {
                let catalog = self.load_models_with_env(config.env.clone()).await;
                let resolved = super::model_alias::resolve_model_alias(&requested, &catalog);
                if resolved != requested {
                    tracing::debug!(
                        %requested,
                        %resolved,
                        "rewrote Claude model alias to concrete catalog id for active profile"
                    );
                }
                Some(resolved)
            }
            None => None,
        };

        // Claude Code CLI v2.1.x parses `--effort` but drops it before building
        // the API request (anthropics/claude-code#41028). The CLI does honor
        // `CLAUDE_CODE_EFFORT_LEVEL`, so set both: the env var is what actually
        // reaches the model today, while `--effort` will start working once
        // the upstream bug is fixed.
        let env = match config.thinking_effort.as_ref() {
            Some(effort) => {
                let mut env = config.env.unwrap_or_default();
                env.insert("CLAUDE_CODE_EFFORT_LEVEL".to_string(), effort.clone());
                Some(env)
            }
            None => config.env,
        };
        let config_dir = super::config_dir::for_env(env.as_ref());
        let options = claude_agent_sdk_rs::Options::builder()
            .cwd(config.cwd.clone())
            .maybe_permission_mode(config.permission_mode.map(map_permission_mode))
            .maybe_model(model)
            .maybe_effort(config.thinking_effort)
            .maybe_system_prompt(config.system_prompt)
            .maybe_resume(config.resume_session_id)
            .allow_dangerously_skip_permissions(config.allow_bypass_permissions)
            .maybe_can_use_tool(config.permission_handler.map(|handler| {
                ClaudeCanUseToolAdapter::shared(handler, config.mcp_servers.as_ref())
            }))
            .maybe_mcp_servers(config.mcp_servers.map(|servers| {
                servers
                    .into_iter()
                    .map(|(name, cfg)| (name, map_mcp_server_config(cfg)))
                    .collect()
            }))
            .maybe_user_config_file(super::config_dir::user_file_for_env(env.as_ref()))
            .maybe_env(env)
            .own_process_group(true)
            .build();

        let query = claude_agent_sdk_rs::query(content, options)
            .await
            .map_err(RuntimeError::from)?;
        let processes = CliProcesses::watch(query.pid(), query.process_exited());
        Ok(Box::new(ClaudeCodeSession {
            query,
            processes,
            turn_control: Default::default(),
            prompt_receipts: std::sync::Arc::new(ClaudePromptReceipts::default()),
            cwd: config.cwd,
            config_dir,
            known_subagents: Vec::new(),
            stop_escalation: None,
        }))
    }
}
