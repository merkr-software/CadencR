mod branching;
mod command_decisions;
mod commands;
mod event_command_actions;
mod event_command_execution;
mod event_inputs;
mod event_items;
mod event_json;
mod event_loop;
mod event_mcp_items;
mod event_payloads;
#[cfg(test)]
mod event_payloads_tests;
mod event_plan;
mod event_plan_item;
mod event_raw;
#[cfg(test)]
mod event_raw_tests;
mod event_reasoning;
mod event_reasoning_state;
mod event_state;
mod event_subagent_activity;
mod event_subagent_routes;
mod event_subagents;
mod event_system;
mod event_turn_state;
mod event_usage;
mod event_web;
mod events;
mod input;
mod instructions;
mod legacy_permissions;
mod mcp;
mod mcp_status;
mod model;
mod permission_details;
mod permission_options;
#[cfg(test)]
mod permission_options_tests;
mod permissions;
mod prompt_receipts;
mod raw_tool_names;
mod responses;
mod runtime_error;
mod session;
mod session_permissions;
mod thread_params;
mod timeouts;
mod trusted_mcp;
mod turn_start;
mod turn_steer_recovery;
mod worktree_config;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use codex_app_server_sdk_rs::{AppServerSpawnOptions, CodexAppServerClient, CodexModel};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use self::instructions::codex_developer_instructions;
use self::mcp::{mcp_server_names, thread_config};
use self::mcp_status::mcp_server_statuses;
pub(crate) use self::model::{canonical_access_mode_wire, configured_access_mode};
pub(crate) use self::raw_tool_names::function_tool_name;
use self::session::CodexSession;
use self::thread_params::{thread_resume_params, thread_start_params};
use self::timeouts::{with_probe_timeout, PROBE_TIMEOUT};
use super::adapter::{
    static_config_paths, AgentRuntimeAdapter, AgentRuntimeSession, RuntimeAccessMode,
    RuntimeCompactionStrategy, RuntimeError, RuntimePermissionRequest,
    RuntimePromptCommandPlacement, RuntimePromptCommandPolicy, RuntimeSkillReferenceTrigger,
    RuntimeSlashCommand, RuntimeSpawnConfig, RuntimeUserShellStrategy,
};
use super::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

pub struct CodexAdapter;
pub const PROVIDER_ID: &str = "codex_cli";
const PROVIDER_LABEL: &str = "Codex CLI";
const CATALOG_TTL: Duration = Duration::from_secs(30);
const DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE: &str = "default_mode_request_user_input";
pub(super) const FAST_SERVICE_TIER: &str = "priority";

pub(super) fn fast_service_tier_value(enabled: bool) -> Value {
    enabled
        .then(|| Value::String(FAST_SERVICE_TIER.to_string()))
        .unwrap_or(Value::Null)
}

#[derive(Clone)]
struct CatalogCacheEntry {
    fetched_at: Instant,
    catalog: ProviderCatalogEntry,
}

static CATALOG_CACHE: OnceLock<RwLock<Option<CatalogCacheEntry>>> = OnceLock::new();
static CATALOG_REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn catalog_cache() -> &'static RwLock<Option<CatalogCacheEntry>> {
    CATALOG_CACHE.get_or_init(|| RwLock::new(None))
}

fn catalog_refresh_lock() -> &'static Mutex<()> {
    CATALOG_REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

fn catalog_from_models(models: Vec<CodexModel>) -> ProviderCatalogEntry {
    let default_model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first())
        .map(|model| model.id.clone());
    ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        icon_data: None,
        status: ProviderStatus::Available,
        status_message: None,
        models: models.into_iter().map(model_entry).collect(),
        modes: Vec::new(),
        access_modes: access_mode_catalog(),
        default_model,
    }
}

fn access_mode_catalog() -> Vec<super::runtime::ProviderModeCatalogEntry> {
    vec![
        super::runtime::ProviderModeCatalogEntry {
            id: "default".to_string(),
            label: "Default".to_string(),
            description: Some(
                "Runs in the workspace-write sandbox. Codex asks you to review command, network, or file access when approval is needed."
                    .to_string(),
            ),
        },
        super::runtime::ProviderModeCatalogEntry {
            id: "fullAccess".to_string(),
            label: "Full Access".to_string(),
            description: Some(
                "Disables sandboxing and approval prompts. Codex can run commands and access files or network without asking first."
                    .to_string(),
            ),
        },
        super::runtime::ProviderModeCatalogEntry {
            id: "autoReview".to_string(),
            label: "Auto Review".to_string(),
            description: Some(
                "Keeps the workspace-write sandbox, but lets Codex automatically review approval requests instead of routing each one to you."
                    .to_string(),
            ),
        },
    ]
}

fn unavailable_catalog(message: impl Into<String>) -> ProviderCatalogEntry {
    ProviderCatalogEntry::unavailable(PROVIDER_ID, PROVIDER_LABEL, message)
}

fn model_entry(model: CodexModel) -> ModelCatalogEntry {
    let mut seen = HashSet::new();
    let default_effort_level = model
        .default_effort
        .map(|effort| effort.trim().to_string())
        .filter(|effort| !effort.is_empty());
    let supported_efforts = model
        .supported_efforts
        .into_iter()
        .filter_map(|effort| {
            let effort = effort.trim().to_string();
            (!effort.is_empty() && seen.insert(effort.clone())).then_some(effort)
        })
        .collect::<Vec<_>>();
    let supports_fast_mode = model
        .service_tiers
        .iter()
        .any(|tier| tier.id == FAST_SERVICE_TIER);
    ModelCatalogEntry {
        id: model.id,
        label: model.label,
        description: model.description,
        supports_effort: Some(!supported_efforts.is_empty()),
        supported_effort_levels: (!supported_efforts.is_empty()).then_some(supported_efforts),
        default_effort_level,
        supports_adaptive_thinking: None,
        supports_fast_mode: Some(supports_fast_mode),
        supports_auto_mode: None,
    }
}

async fn live_catalog() -> ProviderCatalogEntry {
    if let Some(entry) = catalog_cache().read().await.clone() {
        if entry.fetched_at.elapsed() < CATALOG_TTL {
            return entry.catalog;
        }
    }

    let _refresh = catalog_refresh_lock().lock().await;
    if let Some(entry) = catalog_cache().read().await.clone() {
        if entry.fetched_at.elapsed() < CATALOG_TTL {
            return entry.catalog;
        }
    }

    let catalog = match probe_models().await {
        Ok(models) if !models.is_empty() => catalog_from_models(models),
        Ok(_) => unavailable_catalog("codex app-server returned no models"),
        Err(error) => unavailable_catalog(format!("codex app-server unavailable: {error}")),
    };
    *catalog_cache().write().await = Some(CatalogCacheEntry {
        fetched_at: Instant::now(),
        catalog: catalog.clone(),
    });
    catalog
}

async fn probe_models() -> Result<Vec<CodexModel>, RuntimeError> {
    let client = CodexAppServerClient::spawn_with_options(app_server_spawn_options(None)).await?;
    let result = async {
        client.initialize_with_timeout(PROBE_TIMEOUT).await?;
        with_probe_timeout("Codex model/list", client.model_list()).await
    }
    .await;
    client.shutdown().await;
    result
}

fn app_server_spawn_options(env: Option<HashMap<String, String>>) -> AppServerSpawnOptions {
    AppServerSpawnOptions::builder()
        .maybe_env(env)
        .enable_features(vec![DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE.to_string()])
        .build()
}

async fn start_or_resume_thread(
    client: &CodexAppServerClient,
    config: &RuntimeSpawnConfig,
    mcp_config: &Value,
) -> Result<String, RuntimeError> {
    match config.resume_session_id.as_deref() {
        Some(thread_id) => Ok(client
            .thread_resume(thread_resume_params(thread_id, config, mcp_config))
            .await?
            .id),
        None => start_thread(client, config, mcp_config).await,
    }
}

async fn start_thread(
    client: &CodexAppServerClient,
    config: &RuntimeSpawnConfig,
    mcp_config: &Value,
) -> Result<String, RuntimeError> {
    Ok(client
        .thread_start(thread_start_params(config, mcp_config))
        .await?
        .id)
}

#[async_trait]
impl AgentRuntimeAdapter for CodexAdapter {
    fn user_shell_strategy(&self) -> RuntimeUserShellStrategy {
        RuntimeUserShellStrategy::ProviderNative
    }

    fn prompt_command_policy(&self) -> RuntimePromptCommandPolicy {
        RuntimePromptCommandPolicy {
            slash_command_placement: RuntimePromptCommandPlacement::PromptStart,
            skill_reference_trigger: RuntimeSkillReferenceTrigger::Dollar,
            user_shell: true,
        }
    }

    fn session_branching(&self) -> Option<&dyn super::adapter::SessionBranching> {
        Some(&branching::CODEX_SESSION_BRANCHING)
    }

    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        permissions::parse_permission_request(raw)
    }

    fn catalog_entry(&self) -> ProviderCatalogEntry {
        unavailable_catalog("Codex availability has not been checked yet")
    }

    async fn catalog_entry_live(&self) -> ProviderCatalogEntry {
        live_catalog().await
    }

    async fn default_model_id(&self) -> Option<String> {
        live_catalog().await.default_model
    }

    fn spawn_startup_warmup(&self) {
        tokio::spawn(async {
            let _ = live_catalog().await;
        });
    }

    fn supports_prompt_receipts(&self) -> bool {
        true
    }

    fn worktree_config_paths(&self) -> Vec<Cow<'static, str>> {
        static_config_paths(worktree_config::CONFIG_PATHS)
    }

    async fn runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        commands::runtime_slash_commands(cwd).await
    }

    fn compaction_strategy(&self) -> Option<RuntimeCompactionStrategy> {
        Some(RuntimeCompactionStrategy::LiveRuntime)
    }

    fn supports_permission_mode(
        &self,
        mode: &crate::domain::agents::adapter::RuntimePermissionMode,
    ) -> bool {
        // Codex maps Default/AcceptEdits → workspace-write+on-request,
        // Plan → workspace-write+on-request+plan_mode hint, BypassPermissions
        // → danger-full-access. Auto and DontAsk have no Codex equivalent.
        use crate::domain::agents::adapter::RuntimePermissionMode;
        matches!(
            mode,
            RuntimePermissionMode::Default
                | RuntimePermissionMode::AcceptEdits
                | RuntimePermissionMode::Plan
                | RuntimePermissionMode::BypassPermissions
        )
    }

    fn supports_access_mode(&self, _mode: &RuntimeAccessMode) -> bool {
        true
    }

    fn access_mode_setting_key(&self) -> Option<Cow<'static, str>> {
        Some(Cow::Borrowed(self::model::ACCESS_MODE_SETTING_KEY))
    }

    fn applies_access_mode_in_place(&self) -> bool {
        true
    }

    fn default_permission_mode_wire(&self) -> Cow<'static, str> {
        // Codex's chip lands on "Default" (workspace-write + on-request),
        // matching `defaultEditModeFor` in lib/provider-modes.ts.
        Cow::Borrowed("default")
    }

    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        let client =
            CodexAppServerClient::spawn_with_options(app_server_spawn_options(config.env.clone()))
                .await?;
        client.initialize().await?;
        let event_rx = client.subscribe();
        let mut mcp_status_rx = client.subscribe();
        let developer_instructions = codex_developer_instructions();
        let mcp_config = thread_config(config.mcp_servers.as_ref(), Some(&developer_instructions));
        let mcp_server_names = mcp_server_names(&mcp_config);
        let thread_id = start_or_resume_thread(&client, &config, &mcp_config).await?;
        let mcp_servers = mcp_server_statuses(&client, &mut mcp_status_rx, &mcp_server_names).await;
        let session = CodexSession::new(
            client,
            thread_id,
            event_rx,
            session::CodexSessionOptions {
                model: config.model,
                effort: config.thinking_effort,
                fast_mode: config.fast_mode,
                permission_mode: config.permission_mode,
                access_mode: config.access_mode,
                cwd: config.cwd,
                mcp_servers,
                context_window: None,
            },
        );
        session.send_init_event().await;
        if !content.is_null() {
            session.start_initial_turn(content).await?;
        }
        Ok(Box::new(session))
    }
}

#[cfg(test)]
mod tests {
    use super::{app_server_spawn_options, catalog_from_models, model_entry, CodexAdapter};
    use crate::domain::agents::adapter::{AgentRuntimeAdapter, RuntimeUserShellStrategy};
    use codex_app_server_sdk_rs::{CodexModel, CodexServiceTier};
    use serde_json::Value;

    #[test]
    fn catalog_projection_matches_phase_zero_parity_fixture() {
        let catalog = catalog_from_models(vec![
            CodexModel {
                id: "gpt-parity-default".to_string(),
                label: "GPT Parity Default".to_string(),
                description: Some("Default parity model".to_string()),
                supported_efforts: vec![
                    "low".to_string(),
                    "high".to_string(),
                    "high".to_string(),
                    String::new(),
                ],
                default_effort: Some("high".to_string()),
                service_tiers: vec![CodexServiceTier {
                    id: "standard".to_string(),
                    name: "Standard".to_string(),
                    description: None,
                }],
                context_window: Some(200_000),
                is_default: true,
            },
            CodexModel {
                id: "gpt-parity-fast".to_string(),
                label: "GPT Parity Fast".to_string(),
                description: Some("Fast parity model".to_string()),
                supported_efforts: vec!["medium".to_string(), "xhigh".to_string()],
                default_effort: Some("medium".to_string()),
                service_tiers: vec![CodexServiceTier {
                    id: "priority".to_string(),
                    name: "Fast".to_string(),
                    description: Some("Faster service tier".to_string()),
                }],
                context_window: Some(1_000_000),
                is_default: false,
            },
        ]);
        let actual = serde_json::to_value(catalog).expect("Codex catalog should serialize");
        let expected: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/provider_parity/v1/codex_catalog.json"
        )))
        .expect("Codex parity fixture should be valid JSON");

        assert_eq!(actual, expected);
    }

    #[test]
    fn preserves_reasoning_efforts_advertised_by_codex() {
        let entry = model_entry(CodexModel {
            id: "gpt-5.6-sol".to_string(),
            label: "GPT-5.6-Sol".to_string(),
            description: None,
            supported_efforts: vec![
                "low".to_string(),
                "max".to_string(),
                "ultra".to_string(),
                "future".to_string(),
                " ultra ".to_string(),
                String::new(),
            ],
            default_effort: Some("low".to_string()),
            service_tiers: vec![codex_app_server_sdk_rs::CodexServiceTier {
                id: "priority".to_string(),
                name: "Fast".to_string(),
                description: Some("1.5x speed, increased usage".to_string()),
            }],
            context_window: None,
            is_default: true,
        });

        assert_eq!(
            entry.supported_effort_levels,
            Some(vec![
                "low".to_string(),
                "max".to_string(),
                "ultra".to_string(),
                "future".to_string(),
            ])
        );
        assert_eq!(entry.default_effort_level.as_deref(), Some("low"));
        assert_eq!(entry.supports_fast_mode, Some(true));
    }

    #[test]
    fn fast_capability_requires_the_priority_tier_id() {
        let entry = model_entry(CodexModel {
            id: "gpt-future".to_string(),
            label: "GPT Future".to_string(),
            description: None,
            supported_efforts: vec![],
            default_effort: None,
            service_tiers: vec![codex_app_server_sdk_rs::CodexServiceTier {
                id: "standard".to_string(),
                name: "Fast".to_string(),
                description: None,
            }],
            context_window: None,
            is_default: false,
        });

        assert_eq!(entry.supports_fast_mode, Some(false));
    }

    #[test]
    fn advertises_prompt_receipts_for_steering_messages() {
        let adapter = CodexAdapter;
        assert!(adapter.supports_prompt_receipts());
    }

    #[test]
    fn delegates_user_shell_to_codex() {
        assert_eq!(
            CodexAdapter.user_shell_strategy(),
            RuntimeUserShellStrategy::ProviderNative
        );
    }

    #[test]
    fn enables_request_user_input_in_default_mode() {
        let options = app_server_spawn_options(None);
        assert!(options
            .enable_features
            .contains(&"default_mode_request_user_input".to_string()));
    }

    #[test]
    fn leaves_live_request_timeout_to_sdk_default() {
        let options = app_server_spawn_options(None);
        assert!(options.request_timeout.is_none());
    }

    #[test]
    fn advertises_session_branching_capability() {
        let adapter = CodexAdapter;
        assert!(adapter.session_branching().is_some());
    }
}
