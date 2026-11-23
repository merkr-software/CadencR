//! Starting the Claude Code CLI for a runtime spawn.

use std::path::PathBuf;

use serde_json::Value;

use super::cli_model::CliModelResolver;
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
        // Resolved under the profile env (not the effort-augmented one below),
        // the same cache key the settings catalog populated.
        let cli_models = self.cli_model_resolver(config.env.clone()).await;
        let cwd = config.cwd.clone();
        let (options, config_dir) = spawn_options(config, &cli_models);
        let query = claude_agent_sdk_rs::query(content, options)
            .await
            .map_err(RuntimeError::from)?;
        let processes = CliProcesses::watch(query.pid(), query.process_exited());
        Ok(Box::new(ClaudeCodeSession {
            query,
            processes,
            turn_control: Default::default(),
            prompt_receipts: std::sync::Arc::new(ClaudePromptReceipts::default()),
            cwd,
            config_dir,
            cli_models,
            known_subagents: Vec::new(),
            stop_escalation: None,
        }))
    }
}

/// The CLI options of a spawn, and the profile's Claude config dir.
fn spawn_options(
    config: RuntimeSpawnConfig,
    cli_models: &CliModelResolver,
) -> (claude_agent_sdk_rs::Options, Option<PathBuf>) {
    let model = config
        .model
        .as_deref()
        .map(|model| cli_models.resolve(model));
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
    let options =
        claude_agent_sdk_rs::Options::builder()
            .cwd(config.cwd)
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
    (options, config_dir)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::spawn_options;
    use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeSpawnConfig};
    use crate::domain::agents::claude_code::test_support::new_test_adapter;

    /// Rows as the CLI's `initialize` reports them (CLI 2.1.322).
    fn cli_models() -> Vec<claude_agent_sdk_rs::ModelInfo> {
        serde_json::from_value(json!([
            {"value": "default", "resolvedModel": "claude-haiku-5-5", "displayName": "Default (recommended)"},
            {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5"},
            {"value": "haiku", "resolvedModel": "claude-haiku-5-5", "displayName": "Haiku 5.5"},
        ]))
        .expect("CLI model rows")
    }

    fn arg_after(args: &[String], flag: &str) -> Option<String> {
        let at = args.iter().position(|arg| arg == flag)?;
        args.get(at + 1).cloned()
    }

    /// The CLI plans on Sonnet when its model setting is the bare `haiku`
    /// alias ("haiku plan upgrade"); the concrete id keeps the plan on Haiku.
    #[tokio::test]
    async fn plan_mode_haiku_spawns_with_the_concrete_model_id() {
        let adapter = new_test_adapter();
        adapter
            .load_sdk_models_with(None, |_| async { Ok(cli_models()) })
            .await;
        let cli_models = adapter.cli_model_resolver(None).await;
        let config = RuntimeSpawnConfig {
            permission_mode: Some(RuntimePermissionMode::Plan),
            model: Some("haiku".to_string()),
            ..RuntimeSpawnConfig::default()
        };

        let args = spawn_options(config, &cli_models).0.to_cli_args();

        assert_eq!(
            arg_after(&args, "--permission-mode").as_deref(),
            Some("plan")
        );
        assert_eq!(
            arg_after(&args, "--model").as_deref(),
            Some("claude-haiku-5-5")
        );
    }
}
