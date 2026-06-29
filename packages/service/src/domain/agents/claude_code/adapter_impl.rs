use async_trait::async_trait;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::Path;

use super::catalog::fallback_models;
use super::custom_models;
use super::events::context_window_for_model_from_raw;
use super::prompt_receipts::ClaudePromptReceipts;
use super::session::{
    map_mcp_server_config, map_permission_mode, ClaudeCanUseToolAdapter, ClaudeCodeSession,
};
use super::worktree_config;
use super::{ClaudeCodeAdapter, CLAUDE_CODE_ADAPTER};
use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimePermissionMode,
    RuntimeSlashCommand, RuntimeSlashCommandKind, RuntimeSpawnConfig,
};
use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

#[async_trait]
impl AgentRuntimeAdapter for ClaudeCodeAdapter {
    fn is_valid_resume_session_id(&self, session_id: &str) -> bool {
        uuid::Uuid::parse_str(session_id).is_ok()
    }

    fn session_branching(&self) -> Option<&dyn crate::domain::agents::adapter::SessionBranching> {
        Some(&super::CLAUDE_SESSION_BRANCHING)
    }

    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id
            .filter(|sid| uuid::Uuid::parse_str(sid).is_ok())
            .map(ToOwned::to_owned)
    }

    fn catalog_entry(&self) -> ProviderCatalogEntry {
        // Fast, sync path used for registry bootstrap and routing. The
        // authoritative catalog comes from `catalog_entry_live()`.
        let models = fallback_models();
        let default_model = Self::default_model_from(&models);
        ProviderCatalogEntry {
            id: "claude_code".to_string(),
            label: "Claude".to_string(),
            status: ProviderStatus::Available,
            status_message: None,
            models,
            modes: Vec::new(),
            default_model,
        }
    }

    fn spawn_startup_warmup(&self) {
        tokio::spawn(async {
            let _ = CLAUDE_CODE_ADAPTER.load_models().await;
        });
        tokio::spawn(async {
            let _ = CLAUDE_CODE_ADAPTER.load_builtin_slash_commands().await;
        });
    }

    fn worktree_config_paths(&self) -> &'static [&'static str] {
        worktree_config::CONFIG_PATHS
    }

    fn supports_builtin_compact_command(&self) -> bool {
        false
    }

    fn supports_prompt_receipts(&self) -> bool {
        true
    }

    async fn runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        // Filesystem entries are cwd-specific and re-scanned per call;
        // built-ins are cwd-invariant and cached. The two probes are
        // independent, so run them concurrently. Filesystem entries come
        // first so `resolve_commands`'s downstream first-seen dedup keeps
        // user-defined commands over identically-named built-ins.
        let (filesystem, builtins) = tokio::join!(
            claude_agent_sdk_rs::list_filesystem_commands(cwd),
            self.load_builtin_slash_commands(),
        );
        let filesystem = filesystem.map_err(RuntimeError::from)?;

        let mut commands: Vec<RuntimeSlashCommand> = filesystem
            .into_iter()
            .map(|command| RuntimeSlashCommand {
                name: command.name,
                description: command.description,
                kind: RuntimeSlashCommandKind::Command,
            })
            .collect();
        commands.extend(builtins);
        Ok(commands)
    }

    fn supports_permission_mode(&self, mode: &RuntimePermissionMode) -> bool {
        // Claude Code's CLI accepts every built-in variant the SDK exposes.
        !matches!(mode, RuntimePermissionMode::OpenCodeAgent(_))
    }
    // Default edit mode maps to Claude Code's primary edit mode.

    /// Post-plan-approval target: prefer the classifier-backed `auto` mode
    /// when the active model can run it (Sonnet 4.6+ / Opus 4.6+), fall back
    /// to `acceptEdits` otherwise. We consult the live model catalog
    /// (`supports_auto_mode`) so the gate stays in sync with whatever the
    /// CLI advertises rather than baking model-id substrings here.
    fn post_plan_approval_mode_wire(&self, model: Option<&str>) -> &'static str {
        if model
            .map(|id| self.model_supports_auto(id))
            .unwrap_or(false)
        {
            "auto"
        } else {
            "acceptEdits"
        }
    }

    /// Catalog-based detection in `post_plan_approval_mode_wire` is best-
    /// effort: the CLI sometimes advertises auto on alias rows (`sonnet`,
    /// `opus`) even when the resolved model doesn't actually accept
    /// `set_permission_mode("auto")` — Sonnet 4.5 is the canonical
    /// offender. The CLI surfaces this as a `control_response` error
    /// ("auto mode unavailable for this model"); we observe it at runtime
    /// and quietly downgrade to `acceptEdits` so the user still leaves
    /// plan mode without a permission-prompt storm.
    fn post_plan_approval_fallback_mode_wire(
        &self,
        failed_mode_wire: &str,
    ) -> Option<&'static str> {
        if failed_mode_wire == "auto" {
            Some("acceptEdits")
        } else {
            None
        }
    }

    async fn catalog_entry_live(&self) -> ProviderCatalogEntry {
        let models = self.load_models().await;
        provider_catalog_entry_from_models(models)
    }

    async fn catalog_entry_live_for_settings(
        &self,
        _read_pool: &SqlitePool,
        _cwd: Option<&Path>,
        profile: Option<&str>,
    ) -> ProviderCatalogEntry {
        // `profile` lets the prompt-area selector preview a non-active profile's
        // models (Bedrock/Vertex model ids differ from Anthropic). When it is
        // None we fall back to the active profile — and if a named profile fails
        // to resolve we still degrade to the active env rather than break the
        // catalog probe.
        let profile_env = match super::profiles::resolve_profile_env_by_name(profile) {
            Ok((_, env)) => env,
            Err(error) => {
                tracing::warn!(
                    %error,
                    "failed to resolve claude_code profile env for catalog; using active profile"
                );
                super::profiles::resolve_active_profile_env().1
            }
        };
        let models = self.load_models_with_env(profile_env).await;
        provider_catalog_entry_from_models(models)
    }

    async fn default_model_id(&self) -> Option<String> {
        ClaudeCodeAdapter::default_model_id(self).await
    }

    async fn default_model_id_for_settings(&self, _read_pool: &SqlitePool) -> Option<String> {
        let (_, profile_env) = super::profiles::resolve_active_profile_env();
        ClaudeCodeAdapter::default_model_id_with_env(self, profile_env).await
    }

    async fn extra_models(&self, read_pool: &sqlx::SqlitePool) -> Vec<ModelCatalogEntry> {
        match custom_models::list_custom_models(read_pool).await {
            Ok(models) => models,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "failed to load claude_code custom models; returning empty"
                );
                Vec::new()
            }
        }
    }

    fn context_window_for_event(
        &self,
        runtime_event: &RuntimeEvent,
        active_model: Option<&str>,
    ) -> Option<u64> {
        if let Some(model) = active_model {
            if let Some(context_window) =
                context_window_for_model_from_raw(runtime_event.raw_json(), model)
            {
                return Some(context_window);
            }
        }

        runtime_event
            .context_window()
            .or_else(|| runtime_event.init().and_then(|init| init.context_window))
    }

    async fn spawn(
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
        let options = claude_agent_sdk_rs::Options {
            cwd: config.cwd,
            permission_mode: config.permission_mode.map(map_permission_mode),
            model,
            effort: config.thinking_effort,
            system_prompt: config.system_prompt,
            resume: config.resume_session_id,
            allow_dangerously_skip_permissions: config.allow_bypass_permissions,
            mcp_servers: config.mcp_servers.map(|servers| {
                servers
                    .into_iter()
                    .map(|(name, cfg)| (name, map_mcp_server_config(cfg)))
                    .collect()
            }),
            can_use_tool: config.permission_handler.map(|handler| {
                std::sync::Arc::new(ClaudeCanUseToolAdapter { inner: handler })
                    as std::sync::Arc<dyn claude_agent_sdk_rs::CanUseTool>
            }),
            env,
            ..claude_agent_sdk_rs::Options::default()
        };

        let query = claude_agent_sdk_rs::query(content, options)
            .await
            .map_err(RuntimeError::from)?;
        Ok(Box::new(ClaudeCodeSession {
            query,
            prompt_receipts: std::sync::Arc::new(ClaudePromptReceipts::default()),
        }))
    }
}

fn provider_catalog_entry_from_models(models: Vec<ModelCatalogEntry>) -> ProviderCatalogEntry {
    let default_model = ClaudeCodeAdapter::default_model_from(&models);
    ProviderCatalogEntry {
        id: "claude_code".to_string(),
        label: "Claude".to_string(),
        status: ProviderStatus::Available,
        status_message: None,
        models,
        modes: Vec::new(),
        default_model,
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::new_test_adapter;
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, RuntimeSlashCommand, RuntimeSlashCommandKind,
    };

    #[test]
    fn adapter_advertises_prompt_receipts() {
        let adapter = new_test_adapter();
        assert!(adapter.supports_prompt_receipts());
    }

    #[test]
    fn adapter_resume_id_validation_is_uuid_only() {
        let adapter = new_test_adapter();
        assert!(adapter.is_valid_resume_session_id("11111111-1111-4111-8111-111111111111"));
        assert!(!adapter.is_valid_resume_session_id("ses_27f586910ffeUNaKL2l5UARerl"));
    }

    /// Cache hit must skip the CLI spawn — otherwise every popover open
    /// pays the probe cost.
    #[tokio::test]
    async fn load_builtin_slash_commands_short_circuits_after_live_probe() {
        let adapter = new_test_adapter();
        let seeded = vec![RuntimeSlashCommand {
            name: "goal".to_string(),
            description: Some("set or view the goal".to_string()),
            kind: RuntimeSlashCommandKind::Command,
        }];
        {
            let cell = adapter.slash_commands_cell();
            let mut guard = cell.write().expect("cache lock");
            *guard = seeded.clone();
        }
        {
            let mut guard = adapter.slash_commands_probe_state.lock().await;
            guard.live = true;
        }

        let returned = adapter.load_builtin_slash_commands().await;
        assert_eq!(returned, seeded);
    }
}
