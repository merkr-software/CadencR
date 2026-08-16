use async_trait::async_trait;
use serde_json::Value;
use sqlx::SqlitePool;
use std::borrow::Cow;
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
    static_config_paths, AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimeEvent,
    RuntimePermissionMode, RuntimePromptCommandPlacement, RuntimePromptCommandPolicy,
    RuntimeSkillReferenceTrigger, RuntimeSlashCommand, RuntimeSlashCommandKind, RuntimeSpawnConfig,
    RuntimeUserShellStrategy,
};
use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

#[async_trait]
impl AgentRuntimeAdapter for ClaudeCodeAdapter {
    fn user_shell_strategy(&self) -> RuntimeUserShellStrategy {
        RuntimeUserShellStrategy::CadencrManaged
    }

    fn prompt_command_policy(&self) -> RuntimePromptCommandPolicy {
        RuntimePromptCommandPolicy {
            slash_command_placement: RuntimePromptCommandPlacement::Anywhere,
            skill_reference_trigger: RuntimeSkillReferenceTrigger::Slash,
            user_shell: true,
        }
    }

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
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            models,
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model,
        }
    }

    fn canonicalize_model_id(&self, model_id: &str, catalog: &[ModelCatalogEntry]) -> String {
        super::model_alias::resolve_model_alias(model_id, catalog)
    }

    fn spawn_startup_warmup(&self) {
        tokio::spawn(async {
            let _ = CLAUDE_CODE_ADAPTER.load_models().await;
        });
        tokio::spawn(async {
            let _ = CLAUDE_CODE_ADAPTER.load_builtin_slash_commands().await;
        });
    }

    fn worktree_config_paths(&self) -> Vec<Cow<'static, str>> {
        static_config_paths(worktree_config::CONFIG_PATHS)
    }

    fn supports_builtin_compact_command(&self) -> bool {
        false
    }

    fn supports_prompt_receipts(&self) -> bool {
        true
    }

    fn uses_legacy_permission_channel_on_response_error(&self) -> bool {
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
        // Claude Code accepts its SDK permission modes, but not provider-level
        // collaboration modes such as Cursor Ask or OpenCode custom agents.
        !matches!(
            mode,
            RuntimePermissionMode::Ask | RuntimePermissionMode::OpenCodeAgent(_)
        )
    }
    // Default edit mode maps to Claude Code's primary edit mode.

    /// Post-plan-approval target: prefer the classifier-backed `auto` mode
    /// when the active model can run it (Sonnet 4.6+ / Opus 4.6+), fall back
    /// to `acceptEdits` otherwise. We consult the live model catalog
    /// (`supports_auto_mode`) so the gate stays in sync with whatever the
    /// CLI advertises rather than baking model-id substrings here.
    fn post_plan_approval_mode_wire(&self, model: Option<&str>) -> Cow<'static, str> {
        if model
            .map(|id| self.model_supports_auto(id))
            .unwrap_or(false)
        {
            Cow::Borrowed("auto")
        } else {
            Cow::Borrowed("acceptEdits")
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
    ) -> Option<Cow<'static, str>> {
        if failed_mode_wire == "auto" {
            Some(Cow::Borrowed("acceptEdits"))
        } else {
            None
        }
    }

    async fn catalog_entry_live(&self) -> ProviderCatalogEntry {
        let models = self.load_models().await;
        if let Some(message) = self.model_probe_failure_message(None).await {
            return unavailable_catalog(message);
        }
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
        let models = self.load_models_with_env(profile_env.clone()).await;
        if let Some(message) = self.model_probe_failure_message(profile_env.as_ref()).await {
            return unavailable_catalog(message);
        }
        provider_catalog_entry_from_models(models)
    }

    async fn default_model_id(&self) -> Option<String> {
        ClaudeCodeAdapter::default_model_id(self).await
    }

    async fn default_model_id_for_settings(&self, _read_pool: &SqlitePool) -> Option<String> {
        let (_, profile_env) = super::profiles::resolve_active_profile_env();
        ClaudeCodeAdapter::default_model_id_with_env(self, profile_env).await
    }

    fn profile_name_for_new_session(&self) -> Option<String> {
        Some(super::profiles::get_active_profile_name())
    }

    fn environment_for_new_session(&self) -> Option<std::collections::HashMap<String, String>> {
        super::profiles::resolve_active_profile_env().1
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

    /// Context window the CLI knows for `model_id`, without spawning anything.
    /// Used by the model-switch path to reseed the session window instead of
    /// leaving the previous model's in place.
    async fn context_window_for_model(&self, model_id: &str) -> Option<u64> {
        self.context_window_for_model_id(model_id)
    }

    fn context_window_for_event(
        &self,
        runtime_event: &RuntimeEvent,
        active_model: Option<&str>,
    ) -> Option<u64> {
        if runtime_event.is_result() {
            // The only authoritative source the CLI offers. Bank every window
            // it reports so the next turn on any of these models starts out
            // scaled correctly rather than borrowing another model's.
            self.record_context_windows(runtime_event.raw_json());

            if let Some(model) = active_model {
                if let Some(context_window) =
                    context_window_for_model_from_raw(runtime_event.raw_json(), model)
                {
                    return Some(context_window);
                }
            }
        }

        runtime_event.context_window().or_else(|| {
            // The init model id is fully qualified (it keeps the `[1m]` marker,
            // unlike `message_start`), so it can be resolved exactly. This is
            // what makes the *first* turn correct for a model whose id
            // advertises nothing: without it the window stays unknown until the
            // turn's `result` lands.
            runtime_event
                .init()
                .and_then(|init| init.model.as_deref())
                .and_then(|model| self.context_window_for_model_id(model))
        })
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
        let options = claude_agent_sdk_rs::Options::builder()
            .cwd(config.cwd)
            .maybe_permission_mode(config.permission_mode.map(map_permission_mode))
            .maybe_model(model)
            .maybe_effort(config.thinking_effort)
            .maybe_system_prompt(config.system_prompt)
            .maybe_resume(config.resume_session_id)
            .allow_dangerously_skip_permissions(config.allow_bypass_permissions)
            .maybe_mcp_servers(config.mcp_servers.map(|servers| {
                servers
                    .into_iter()
                    .map(|(name, cfg)| (name, map_mcp_server_config(cfg)))
                    .collect()
            }))
            .maybe_can_use_tool(config.permission_handler.map(|handler| {
                std::sync::Arc::new(ClaudeCanUseToolAdapter { inner: handler })
                    as std::sync::Arc<dyn claude_agent_sdk_rs::CanUseTool>
            }))
            .maybe_env(env)
            .build();

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
        icon_data: None,
        status: ProviderStatus::Available,
        status_message: None,
        models,
        modes: Vec::new(),
        access_modes: Vec::new(),
        default_model,
    }
}

fn unavailable_catalog(message: impl Into<String>) -> ProviderCatalogEntry {
    ProviderCatalogEntry::unavailable("claude_code", "Claude", message)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::events::normalize_event;
    use super::super::test_support::new_test_adapter;
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, RuntimePromptCommandPlacement, RuntimeSkillReferenceTrigger,
        RuntimeSlashCommand, RuntimeSlashCommandKind, RuntimeUserShellStrategy,
    };

    #[test]
    fn fallback_catalog_matches_phase_zero_parity_fixture() {
        let actual = serde_json::to_value(new_test_adapter().catalog_entry())
            .expect("Claude fallback catalog should serialize");
        let expected: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/provider_parity/v1/claude_code_catalog.json"
        )))
        .expect("Claude parity fixture should be valid JSON");

        assert_eq!(actual, expected);
    }

    fn init_event(model: &str) -> crate::domain::agents::adapter::RuntimeEvent {
        normalize_event(
            serde_json::from_value(json!({
                "type": "system",
                "subtype": "init",
                "uuid": "u-init",
                "session_id": "s-init",
                "claude_code_version": "2.0.75",
                "cwd": "/tmp",
                "tools": [],
                "mcp_servers": [],
                "model": model,
                "permissionMode": "default",
                "slash_commands": [],
                "output_style": "default"
            }))
            .expect("valid init message"),
        )
    }

    fn result_event(
        model: &str,
        context_window: u64,
    ) -> crate::domain::agents::adapter::RuntimeEvent {
        normalize_event(
            serde_json::from_value(json!({
                "type": "result",
                "subtype": "success",
                "uuid": "u-result",
                "session_id": "s-init",
                "duration_ms": 1,
                "duration_api_ms": 1,
                "is_error": false,
                "num_turns": 1,
                "result": "ok",
                "errors": null,
                "stop_reason": "end_turn",
                "total_cost_usd": 0.0,
                "usage": {
                    "input_tokens": 1,
                    "output_tokens": 1,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                },
                // The CLI bills a background Haiku call on essentially every
                // turn, so a real `modelUsage` is never a single entry.
                "modelUsage": {
                    "claude-haiku-4-5-20251001": { "contextWindow": 200_000 },
                    model: { "contextWindow": context_window }
                },
                "permission_denials": [],
                "structured_output": null
            }))
            .expect("valid result message"),
        )
    }

    #[test]
    fn resolves_1m_window_at_init_for_a_natively_1m_model() {
        // The bug: the CLI reports `claude-fable-5` (no `[1m]` — 1M is its
        // default), so the whole turn ran with no window and the bar divided
        // by the session's stale one until the turn's result landed.
        let adapter = new_test_adapter();
        assert_eq!(
            adapter.context_window_for_event(&init_event("claude-fable-5"), None),
            Some(1_000_000)
        );
    }

    #[test]
    fn prefers_the_active_models_own_entry_over_a_background_models() {
        let adapter = new_test_adapter();
        let event = result_event("active[1m]", 1_000_000);

        assert_eq!(
            adapter.context_window_for_event(&event, Some("active[1m]")),
            Some(1_000_000)
        );
    }

    #[test]
    fn learns_a_window_from_a_result_and_reuses_it_at_the_next_init() {
        let adapter = new_test_adapter();
        // A model whose id advertises nothing: unknown on the first turn...
        assert_eq!(
            adapter.context_window_for_event(&init_event("unmarked"), None),
            None
        );

        // ...but the turn's result is authoritative, so every later session on
        // that model is scaled correctly from its very first event.
        adapter.context_window_for_event(&result_event("unmarked", 400_000), None);
        assert_eq!(
            adapter.context_window_for_event(&init_event("unmarked"), None),
            Some(400_000)
        );
    }

    #[test]
    fn non_result_events_never_touch_the_learned_windows() {
        // `context_window_for_event` runs on every streaming delta, so the
        // learning write must be gated on the one event that can carry it.
        let adapter = new_test_adapter();
        adapter.context_window_for_event(&init_event("unlearned"), Some("unlearned"));
        assert_eq!(adapter.learned_context_window("unlearned"), None);
    }

    #[tokio::test]
    async fn answers_context_window_for_model_from_marker_and_learned_history() {
        let adapter = new_test_adapter();
        assert_eq!(
            adapter.context_window_for_model("claude-fable-5[1m]").await,
            Some(1_000_000)
        );
        assert_eq!(adapter.context_window_for_model("seed-unknown").await, None);

        adapter.context_window_for_event(&result_event("seed-unknown", 300_000), None);
        assert_eq!(
            adapter.context_window_for_model("seed-unknown").await,
            Some(300_000)
        );
    }

    #[test]
    fn adapter_advertises_prompt_receipts() {
        let adapter = new_test_adapter();
        assert!(adapter.supports_prompt_receipts());
    }

    #[test]
    fn adapter_owns_the_legacy_permission_channel_fallback() {
        assert!(new_test_adapter().uses_legacy_permission_channel_on_response_error());
    }

    #[test]
    fn delegates_user_shell_to_cadencr() {
        assert_eq!(
            new_test_adapter().user_shell_strategy(),
            RuntimeUserShellStrategy::CadencrManaged
        );
    }

    #[test]
    fn adapter_advertises_mid_prompt_slash_commands() {
        let policy = new_test_adapter().prompt_command_policy();
        assert_eq!(
            policy.slash_command_placement,
            RuntimePromptCommandPlacement::Anywhere
        );
        assert_eq!(
            policy.skill_reference_trigger,
            RuntimeSkillReferenceTrigger::Slash
        );
        assert!(policy.user_shell);
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
