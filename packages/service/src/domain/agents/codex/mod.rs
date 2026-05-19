mod command_decisions;
mod commands;
mod event_command_actions;
mod event_command_execution;
mod event_inputs;
mod event_items;
mod event_json;
mod event_loop;
mod event_mcp_items;
mod event_plan;
mod event_plan_item;
mod event_raw;
mod event_state;
mod event_subagents;
mod event_system;
mod event_turn_state;
mod event_usage;
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
mod session;
mod session_permissions;
mod thread_params;
mod turn_start;
mod worktree_config;

use std::collections::HashMap;
use std::future::Future;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use codex_app_server_sdk_rs::{AppServerSpawnOptions, CodexAppServerClient, CodexModel};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use self::instructions::codex_developer_instructions;
use self::mcp::{mcp_server_names, thread_config};
use self::mcp_status::mcp_server_statuses;
use self::session::CodexSession;
use self::thread_params::{thread_resume_params, thread_start_params};
use super::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeCompactionStrategy, RuntimeError,
    RuntimePermissionRequest, RuntimeSlashCommand, RuntimeSpawnConfig,
};
use super::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

pub struct CodexAdapter;
pub static CODEX_ADAPTER: CodexAdapter = CodexAdapter;
pub const PROVIDER_ID: &str = "codex_cli";
const PROVIDER_LABEL: &str = "Codex CLI";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CATALOG_TTL: Duration = Duration::from_secs(30);
const DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE: &str = "default_mode_request_user_input";

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

pub(super) async fn with_timeout<T>(
    operation: &'static str,
    future: impl Future<Output = Result<T, codex_app_server_sdk_rs::SdkError>>,
) -> Result<T, RuntimeError> {
    with_timeout_sdk(operation, future)
        .await
        .map_err(RuntimeError::from)
}

pub(super) async fn with_timeout_sdk<T>(
    operation: &'static str,
    future: impl Future<Output = Result<T, codex_app_server_sdk_rs::SdkError>>,
) -> Result<T, codex_app_server_sdk_rs::SdkError> {
    tokio::time::timeout(PROBE_TIMEOUT, future)
        .await
        .map_err(|_| codex_app_server_sdk_rs::SdkError::Timeout(operation))?
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
        status: ProviderStatus::Available,
        status_message: None,
        models: models.into_iter().map(model_entry).collect(),
        modes: Vec::new(),
        default_model,
    }
}

fn unavailable_catalog(message: impl Into<String>) -> ProviderCatalogEntry {
    ProviderCatalogEntry {
        id: PROVIDER_ID.to_string(),
        label: PROVIDER_LABEL.to_string(),
        status: ProviderStatus::Unavailable,
        status_message: Some(message.into()),
        models: Vec::new(),
        modes: Vec::new(),
        default_model: None,
    }
}

fn model_entry(model: CodexModel) -> ModelCatalogEntry {
    let supported_efforts = model
        .supported_efforts
        .into_iter()
        .filter(|effort| matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh"))
        .collect::<Vec<_>>();
    ModelCatalogEntry {
        id: model.id,
        label: model.label,
        description: model.description,
        supports_effort: Some(!supported_efforts.is_empty()),
        supported_effort_levels: (!supported_efforts.is_empty()).then_some(supported_efforts),
        supports_adaptive_thinking: None,
        supports_fast_mode: None,
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
        with_timeout("Codex model/list", client.model_list()).await
    }
    .await;
    client.shutdown().await;
    result
}

fn app_server_spawn_options(env: Option<HashMap<String, String>>) -> AppServerSpawnOptions {
    AppServerSpawnOptions {
        env,
        enable_features: vec![DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE.to_string()],
        ..AppServerSpawnOptions::default()
    }
}

async fn start_or_resume_thread(
    client: &CodexAppServerClient,
    config: &RuntimeSpawnConfig,
    mcp_config: &Value,
) -> Result<String, RuntimeError> {
    match config.resume_session_id.as_deref() {
        Some(thread_id) => Ok(with_timeout(
            "Codex thread/resume",
            client.thread_resume(thread_resume_params(thread_id, config, mcp_config)),
        )
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
    Ok(with_timeout(
        "Codex thread/start",
        client.thread_start(thread_start_params(config, mcp_config)),
    )
    .await?
    .id)
}

#[async_trait]
impl AgentRuntimeAdapter for CodexAdapter {
    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        permissions::parse_permission_request(raw)
    }

    fn accepts_model(&self, model: &str) -> bool {
        self::model::accepts_model(model)
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

    fn worktree_config_paths(&self) -> &'static [&'static str] {
        worktree_config::CONFIG_PATHS
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

    fn default_permission_mode_wire(&self) -> &'static str {
        // Codex's chip lands on "Default" (workspace-write + on-request),
        // matching `defaultEditModeFor` in lib/provider-modes.ts.
        "default"
    }

    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        let client =
            CodexAppServerClient::spawn_with_options(app_server_spawn_options(config.env.clone()))
                .await?;
        client.initialize_with_timeout(PROBE_TIMEOUT).await?;
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
            config.model,
            config.thinking_effort,
            config.permission_mode,
            config.cwd,
            event_rx,
            mcp_servers,
            None,
        );
        session.send_init_event().await;
        session.start_initial_turn(content).await?;
        Ok(Box::new(session))
    }
}

#[cfg(test)]
mod tests {
    use super::{app_server_spawn_options, CodexAdapter};
    use crate::domain::agents::adapter::AgentRuntimeAdapter;

    #[test]
    fn accepts_bare_codex_and_gpt_models() {
        let adapter = CodexAdapter;
        assert!(adapter.accepts_model("gpt-5.4"));
        assert!(adapter.accepts_model("codex-mini"));
        assert!(!adapter.accepts_model("openai/gpt-5.4"));
    }

    #[test]
    fn advertises_prompt_receipts_for_steering_messages() {
        let adapter = CodexAdapter;
        assert!(adapter.supports_prompt_receipts());
    }

    #[test]
    fn enables_request_user_input_in_default_mode() {
        let options = app_server_spawn_options(None);
        assert!(options
            .enable_features
            .contains(&"default_mode_request_user_input".to_string()));
    }
}
