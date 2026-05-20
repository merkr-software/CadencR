mod catalog;
pub mod custom_models;
mod events;
pub mod profiles;
mod prompt_receipts;
pub mod routes;
mod worktree_config;

pub const PROVIDER_ID: &str = "claude_code";

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;

use self::catalog::fallback_models;
use self::events::{context_window_for_model_from_raw, normalize_event};
use self::prompt_receipts::ClaudePromptReceipts;
use super::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimeEvent, RuntimeMcpServerConfig,
    RuntimeMessageRx, RuntimePermissionMode, RuntimePermissionUpdate, RuntimeSlashCommand,
    RuntimeSlashCommandKind, RuntimeSpawnConfig, RuntimeToolPermissionHandler,
    RuntimeToolPermissionRequest, RuntimeToolPermissionResult,
};
use super::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

pub struct ClaudeCodeAdapter {
    /// Process-lifetime cache of the model catalog. Pre-populated with a
    /// static fallback list of the historical aliases so the UI has
    /// something to show before the CLI probe completes; replaced with the
    /// live CLI-reported list on first successful probe.
    cached_models: std::sync::OnceLock<std::sync::RwLock<Vec<ModelCatalogEntry>>>,
    /// Serialises concurrent probes and tracks whether the cached list is
    /// already authoritative (live from the CLI). Unlike `OnceCell`, this
    /// lets the probe run again after a failure or empty response — the UI
    /// would otherwise be stuck on fallback aliases until service restart.
    probe_state: tokio::sync::Mutex<ProbeState>,
    /// Cache of CLI built-in slash commands. Cwd-invariant, so one cache
    /// serves every session; per-cwd filesystem entries are scanned fresh.
    /// Same retry-on-failure semantics as `cached_models` / `probe_state`.
    cached_slash_commands: std::sync::OnceLock<std::sync::RwLock<Vec<RuntimeSlashCommand>>>,
    slash_commands_probe_state: tokio::sync::Mutex<ProbeState>,
}

#[derive(Default)]
struct ProbeState {
    live: bool,
}

pub static CLAUDE_CODE_ADAPTER: ClaudeCodeAdapter = ClaudeCodeAdapter {
    cached_models: std::sync::OnceLock::new(),
    probe_state: tokio::sync::Mutex::const_new(ProbeState { live: false }),
    cached_slash_commands: std::sync::OnceLock::new(),
    slash_commands_probe_state: tokio::sync::Mutex::const_new(ProbeState { live: false }),
};

/// Seed the static `CLAUDE_CODE_ADAPTER`'s model catalog from a test.
/// Crate-visible so tests in other modules (e.g. the post-plan-mode
/// orchestrator) can drive `post_plan_approval_mode_wire` to a known
/// outcome without needing access to the private cache cell.
#[cfg(test)]
pub(crate) fn seed_static_catalog_for_tests(models: Vec<ModelCatalogEntry>) {
    let cell = CLAUDE_CODE_ADAPTER.models_cell();
    if let Ok(mut guard) = cell.write() {
        *guard = models;
    }
}

impl ClaudeCodeAdapter {
    /// Whether the active model can run Claude's classifier-backed `auto`
    /// mode (Sonnet 4.6+ / Opus 4.6+).
    ///
    /// Non-obvious: the live CLI catalog only sets `supportsAutoMode: true`
    /// on the `default` row; aliases like `sonnet` / `opus` ship with the
    /// flag unset even though they resolve to auto-capable models. So we
    /// trust those modern aliases when *any* catalog entry advertises auto
    /// (proof this CLI version knows about the mode). `haiku` is excluded
    /// because Haiku 4.5 doesn't support it. Behaviour matrix lives in the
    /// `post_plan_approval_mode_*` tests below.
    pub(super) fn model_supports_auto(&self, model_id: &str) -> bool {
        let Ok(models) = self.models_cell().read() else {
            return false;
        };
        if let Some(Some(flag)) = models
            .iter()
            .find(|m| m.id == model_id)
            .map(|m| m.supports_auto_mode)
        {
            return flag;
        }
        let is_modern_alias = matches!(model_id, "default" | "sonnet" | "opus");
        is_modern_alias && models.iter().any(|m| m.supports_auto_mode == Some(true))
    }
}

pub struct ClaudeCodeSession {
    query: claude_agent_sdk_rs::Query,
    prompt_receipts: std::sync::Arc<ClaudePromptReceipts>,
}

impl ClaudeCodeSession {
    #[cfg(test)]
    pub(crate) fn from_query(query: claude_agent_sdk_rs::Query) -> Self {
        Self {
            query,
            prompt_receipts: std::sync::Arc::new(ClaudePromptReceipts::default()),
        }
    }
}

struct ClaudeCanUseToolAdapter {
    inner: std::sync::Arc<dyn RuntimeToolPermissionHandler>,
}

#[async_trait]
impl claude_agent_sdk_rs::CanUseTool for ClaudeCanUseToolAdapter {
    async fn can_use_tool(
        &self,
        request: claude_agent_sdk_rs::PermissionRequest,
    ) -> claude_agent_sdk_rs::PermissionResult {
        match self
            .inner
            .can_use_tool(RuntimeToolPermissionRequest {
                tool_name: request.tool_name,
                tool_use_id: request.tool_use_id,
                permission_updates: request
                    .suggestions
                    .unwrap_or_default()
                    .into_iter()
                    .map(|update| RuntimePermissionUpdate { data: update.data })
                    .collect(),
                blocked_path: request.blocked_path,
                decision_reason: request.decision_reason,
                input: request.input,
            })
            .await
        {
            RuntimeToolPermissionResult::Allow {
                updated_input,
                updated_permissions,
                tool_use_id,
            } => claude_agent_sdk_rs::PermissionResult::Allow {
                updated_input,
                updated_permissions: updated_permissions.map(|updates| {
                    updates
                        .into_iter()
                        .map(|update| claude_agent_sdk_rs::PermissionUpdate { data: update.data })
                        .collect()
                }),
                tool_use_id,
            },
            RuntimeToolPermissionResult::Deny {
                message,
                interrupt,
                tool_use_id,
            } => claude_agent_sdk_rs::PermissionResult::Deny {
                message,
                interrupt,
                tool_use_id,
            },
        }
    }
}

fn map_permission_mode(mode: RuntimePermissionMode) -> claude_agent_sdk_rs::PermissionMode {
    match mode {
        RuntimePermissionMode::Default => claude_agent_sdk_rs::PermissionMode::Default,
        RuntimePermissionMode::AcceptEdits => claude_agent_sdk_rs::PermissionMode::AcceptEdits,
        RuntimePermissionMode::BypassPermissions => {
            claude_agent_sdk_rs::PermissionMode::BypassPermissions
        }
        RuntimePermissionMode::Plan => claude_agent_sdk_rs::PermissionMode::Plan,
        RuntimePermissionMode::Auto => claude_agent_sdk_rs::PermissionMode::Auto,
        RuntimePermissionMode::DontAsk => claude_agent_sdk_rs::PermissionMode::DontAsk,
    }
}

fn map_mcp_server_config(
    config: RuntimeMcpServerConfig,
) -> claude_agent_sdk_rs::mcp::McpServerConfig {
    match config {
        RuntimeMcpServerConfig::Stdio { command, args, env } => {
            claude_agent_sdk_rs::mcp::McpServerConfig::Stdio { command, args, env }
        }
    }
}

#[async_trait]
impl AgentRuntimeSession for ClaudeCodeSession {
    fn take_message_rx(&mut self) -> RuntimeMessageRx {
        let mut source_rx = self.query.take_message_rx();
        let (tx, rx) = mpsc::channel(64);
        let prompt_receipts = std::sync::Arc::clone(&self.prompt_receipts);

        tokio::spawn(async move {
            while let Some(msg) = source_rx.recv().await {
                if let Ok(sdk_msg) = &msg {
                    if let Some(event) = acknowledge_user_prompt_receipt(sdk_msg, &prompt_receipts)
                    {
                        if tx.send(Ok(event)).await.is_err() {
                            break;
                        }
                        continue;
                    }
                    if is_unmatched_replay_user_message(sdk_msg) {
                        continue;
                    }
                }

                let mapped = msg.map(normalize_event).map_err(RuntimeError::from);
                if tx.send(mapped).await.is_err() {
                    break;
                }
            }
        });

        rx
    }

    async fn session_id(&self) -> Option<String> {
        self.query.session_id().await
    }

    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError> {
        self.query
            .stream_input(content)
            .await
            .map_err(RuntimeError::from)
    }

    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        let Some(client_message_id) = client_message_id else {
            return self.stream_input(content).await;
        };

        self.prompt_receipts
            .enqueue(client_message_id.clone(), &content);
        let result = self
            .query
            .stream_input(content)
            .await
            .map_err(RuntimeError::from);
        if result.is_err() {
            self.prompt_receipts.discard(&client_message_id);
        }
        result
    }

    async fn interrupt(&self) -> Result<(), RuntimeError> {
        self.query.interrupt().await.map_err(RuntimeError::from)
    }

    async fn close(&mut self) {
        self.query.close().await;
    }

    async fn set_model(&self, model: &str) -> Result<(), RuntimeError> {
        self.query
            .set_model(model)
            .await
            .map_err(RuntimeError::from)
    }

    async fn set_permission_mode(&self, mode: RuntimePermissionMode) -> Result<(), RuntimeError> {
        self.query
            .set_permission_mode(map_permission_mode(mode))
            .await
            .map_err(RuntimeError::from)
    }

    fn pid(&self) -> Option<u32> {
        self.query.pid()
    }
}

fn acknowledge_user_prompt_receipt(
    msg: &claude_agent_sdk_rs::SdkMessage,
    prompt_receipts: &ClaudePromptReceipts,
) -> Option<RuntimeEvent> {
    let claude_agent_sdk_rs::SdkMessage::User { message, .. } = msg else {
        return None;
    };
    prompt_receipts.acknowledge_replay(message)
}

fn is_unmatched_replay_user_message(msg: &claude_agent_sdk_rs::SdkMessage) -> bool {
    matches!(
        msg,
        claude_agent_sdk_rs::SdkMessage::User {
            is_replay: Some(true),
            ..
        }
    )
}

#[async_trait]
impl AgentRuntimeAdapter for ClaudeCodeAdapter {
    fn is_valid_resume_session_id(&self, session_id: &str) -> bool {
        uuid::Uuid::parse_str(session_id).is_ok()
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

    fn supports_permission_mode(&self, _mode: &RuntimePermissionMode) -> bool {
        // Claude Code's CLI accepts every variant the SDK exposes.
        true
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
        let default_model = Self::default_model_from(&models);
        ProviderCatalogEntry {
            id: "claude_code".to_string(),
            label: "Claude".to_string(),
            status: ProviderStatus::Available,
            status_message: None,
            models,
            default_model,
        }
    }

    async fn default_model_id(&self) -> Option<String> {
        ClaudeCodeAdapter::default_model_id(self).await
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
            model: config.model,
            effort: config.thinking_effort,
            system_prompt: config.system_prompt,
            resume: config.resume_session_id,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        acknowledge_user_prompt_receipt, is_unmatched_replay_user_message, map_permission_mode,
        ClaudeCodeAdapter, ProbeState,
    };
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, RuntimePermissionMode, RuntimeSlashCommand, RuntimeSlashCommandKind,
    };
    use crate::domain::agents::claude_code::prompt_receipts::ClaudePromptReceipts;
    use crate::domain::agents::runtime::ModelCatalogEntry;

    fn new_test_adapter() -> ClaudeCodeAdapter {
        ClaudeCodeAdapter {
            cached_models: std::sync::OnceLock::new(),
            probe_state: tokio::sync::Mutex::new(ProbeState::default()),
            cached_slash_commands: std::sync::OnceLock::new(),
            slash_commands_probe_state: tokio::sync::Mutex::new(ProbeState::default()),
        }
    }

    fn seed_models(adapter: &ClaudeCodeAdapter, models: Vec<ModelCatalogEntry>) {
        let cell = adapter.models_cell();
        let mut guard = cell.write().expect("cache lock");
        *guard = models;
    }

    fn model_with_auto(id: &str, supports_auto: Option<bool>) -> ModelCatalogEntry {
        ModelCatalogEntry {
            id: id.to_string(),
            label: id.to_string(),
            description: None,
            supports_effort: None,
            supported_effort_levels: None,
            supports_adaptive_thinking: None,
            supports_fast_mode: None,
            supports_auto_mode: supports_auto,
        }
    }

    #[test]
    fn adapter_advertises_prompt_receipts() {
        let adapter = new_test_adapter();
        assert!(adapter.supports_prompt_receipts());
    }

    #[test]
    fn acknowledges_matching_plain_user_echo_as_prompt_receipt() {
        let receipts = ClaudePromptReceipts::default();
        receipts.enqueue("client-1".to_string(), &json!("And the lint please"));
        let msg = claude_agent_sdk_rs::SdkMessage::User {
            uuid: None,
            session_id: "session-1".to_string(),
            message: json!({
                "role": "user",
                "content": "And the lint please"
            }),
            parent_tool_use_id: None,
            is_synthetic: None,
            tool_use_result: None,
            is_replay: None,
        };

        let event = acknowledge_user_prompt_receipt(&msg, &receipts).expect("receipt");

        assert_eq!(event.prompt_received_client_message_id(), Some("client-1"));
        assert!(!is_unmatched_replay_user_message(&msg));
    }

    #[test]
    fn suppresses_unmatched_explicit_replay_user_echo() {
        let msg = claude_agent_sdk_rs::SdkMessage::User {
            uuid: None,
            session_id: "session-1".to_string(),
            message: json!({
                "role": "user",
                "content": "something else"
            }),
            parent_tool_use_id: None,
            is_synthetic: None,
            tool_use_result: None,
            is_replay: Some(true),
        };

        assert!(is_unmatched_replay_user_message(&msg));
    }

    #[test]
    fn map_permission_mode_covers_all_variants() {
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::Default),
            claude_agent_sdk_rs::PermissionMode::Default
        );
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::AcceptEdits),
            claude_agent_sdk_rs::PermissionMode::AcceptEdits
        );
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::BypassPermissions),
            claude_agent_sdk_rs::PermissionMode::BypassPermissions
        );
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::Plan),
            claude_agent_sdk_rs::PermissionMode::Plan
        );
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::Auto),
            claude_agent_sdk_rs::PermissionMode::Auto
        );
        assert_eq!(
            map_permission_mode(RuntimePermissionMode::DontAsk),
            claude_agent_sdk_rs::PermissionMode::DontAsk
        );
    }

    #[test]
    fn adapter_resume_id_validation_is_uuid_only() {
        let adapter = new_test_adapter();
        assert!(adapter.is_valid_resume_session_id("11111111-1111-4111-8111-111111111111"));
        assert!(!adapter.is_valid_resume_session_id("ses_27f586910ffeUNaKL2l5UARerl"));
    }

    #[test]
    fn post_plan_approval_mode_returns_auto_when_model_supports_it() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("claude-sonnet-4-6")),
            "auto"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_to_accept_edits_when_model_does_not_support_auto() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-5", Some(false))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("claude-sonnet-4-5")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_trusts_modern_aliases_when_catalog_advertises_auto_elsewhere() {
        // Reproduces the real CLI shape we saw in the wild: only the
        // `default` row carries `supportsAutoMode: true`; the `sonnet` /
        // `opus` aliases ship with the flag unset even though they
        // resolve to auto-capable models at runtime.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("sonnet", None),
                model_with_auto("opus", None),
                model_with_auto("haiku", None),
            ],
        );
        assert_eq!(adapter.post_plan_approval_mode_wire(Some("sonnet")), "auto");
        assert_eq!(adapter.post_plan_approval_mode_wire(Some("opus")), "auto");
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("default")),
            "auto"
        );
    }

    #[test]
    fn post_plan_approval_mode_matches_live_cli_catalog_shape_for_sonnet_alias() {
        // Regression: production hit `target_mode="acceptEdits"` for a
        // session running model="sonnet" because the live CLI catalog
        // ships the alias rows without `supportsAutoMode`. The shape
        // below is taken verbatim from the SDK's live-CLI mock at
        // `claude-agent-sdk-rs/src/query.rs::supported_models_extracts_models_from_control_response`
        // — if that wire format ever changes, this test catches it
        // before the bug returns.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                ModelCatalogEntry {
                    id: "default".to_string(),
                    label: "Default (recommended)".to_string(),
                    description: Some("Opus 4.7 with 1M context".to_string()),
                    supports_effort: Some(true),
                    supported_effort_levels: Some(vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                        "xhigh".to_string(),
                        "max".to_string(),
                    ]),
                    supports_adaptive_thinking: Some(true),
                    supports_fast_mode: None,
                    supports_auto_mode: Some(true),
                },
                ModelCatalogEntry {
                    id: "sonnet".to_string(),
                    label: "Sonnet".to_string(),
                    description: Some("Sonnet 4.6".to_string()),
                    supports_effort: None,
                    supported_effort_levels: None,
                    supports_adaptive_thinking: None,
                    supports_fast_mode: None,
                    supports_auto_mode: None,
                },
                ModelCatalogEntry {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                    description: Some("Haiku 4.5".to_string()),
                    supports_effort: None,
                    supported_effort_levels: None,
                    supports_adaptive_thinking: None,
                    supports_fast_mode: None,
                    supports_auto_mode: None,
                },
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "auto",
            "sonnet alias must resolve to `auto` post-plan-approval — \
             this is the production regression"
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("default")),
            "auto"
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("haiku")),
            "acceptEdits",
            "haiku 4.5 doesn't support auto mode"
        );
    }

    #[test]
    fn post_plan_approval_mode_does_not_trust_haiku_alias() {
        // Haiku 4.5 doesn't support the classifier-backed mode — the alias
        // must NOT be trusted into `auto` even when the catalog has
        // auto-capable peers.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("haiku", None),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("haiku")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_does_not_trust_aliases_when_cli_lacks_auto_support() {
        // Older CLI catalog where no model advertises auto: the alias
        // shouldn't be promoted to `auto` since the CLI itself wouldn't
        // honor it.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", None),
                model_with_auto("sonnet", None),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_respects_explicit_false_on_alias_row() {
        // If the CLI ever sets `supports_auto_mode: false` explicitly on
        // an alias, that wins over the alias-trust fallback.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("sonnet", Some(false)),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_for_unknown_model_id() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("not-a-real-model")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_when_no_model_provided() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(adapter.post_plan_approval_mode_wire(None), "acceptEdits");
    }

    #[test]
    fn post_plan_approval_fallback_recovers_auto_to_accept_edits() {
        // When the CLI rejects `auto` (Sonnet 4.5 et al), the orchestrator
        // should try `acceptEdits` instead — the user still leaves plan
        // mode without a permission prompt on every edit.
        let adapter = new_test_adapter();
        assert_eq!(
            adapter.post_plan_approval_fallback_mode_wire("auto"),
            Some("acceptEdits")
        );
    }

    #[test]
    fn post_plan_approval_fallback_has_no_recovery_for_other_modes() {
        // Only the `auto`-specific catalog optimism is recoverable today;
        // a rejection of `acceptEdits` or `default` is a real CLI failure
        // and should propagate to the user via the standard error envelope.
        let adapter = new_test_adapter();
        assert_eq!(
            adapter.post_plan_approval_fallback_mode_wire("acceptEdits"),
            None
        );
        assert_eq!(
            adapter.post_plan_approval_fallback_mode_wire("default"),
            None
        );
        assert_eq!(adapter.post_plan_approval_fallback_mode_wire("plan"), None);
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
