//! The provider-neutral runtime adapter for code-backed provider packages.
//!
//! The descriptor supplies identity and an executable, never model data. The
//! executable owns provider-specific discovery/parsing through its mandatory
//! `models` command; ACP remains the live session protocol.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};

use crate::domain::agents::acp::runtime::permission_events::parse_acp_permission_request;
use crate::domain::agents::acp::runtime::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::AcpClientInfo;
use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeError, RuntimePermissionRequest,
    RuntimeSpawnConfig,
};
use crate::domain::agents::runtime::{ProviderCatalogEntry, ProviderStatus};

use super::hooks::{InstalledAcpCapabilities, InstalledAcpHooks};
use super::installation::HostInstallation;
use super::model_discovery::{discover_models, DiscoveredModels};

const CATALOG_TTL: Duration = Duration::from_secs(30);
const MAX_CACHED_WORKSPACES: usize = 16;

#[derive(Clone)]
struct CatalogCacheEntry {
    fetched_at: Instant,
    discovered: DiscoveredModels,
}

pub struct GenericAcpAdapter {
    installation: Arc<HostInstallation>,
    capabilities: Arc<InstalledAcpCapabilities>,
    catalog_cache: RwLock<HashMap<PathBuf, CatalogCacheEntry>>,
    catalog_refreshes: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl GenericAcpAdapter {
    pub fn new(installation: Arc<HostInstallation>) -> Self {
        Self {
            installation,
            capabilities: Arc::new(InstalledAcpCapabilities::default()),
            catalog_cache: RwLock::new(HashMap::new()),
            catalog_refreshes: Mutex::new(HashMap::new()),
        }
    }

    async fn discover_for_cwd(&self, cwd: &Path) -> Result<DiscoveredModels, RuntimeError> {
        if let Some(discovered) = self.fresh_cache(cwd).await {
            return Ok(discovered);
        }
        let refresh = self.refresh_lock(cwd).await;
        let _refresh = refresh.lock().await;
        if let Some(discovered) = self.fresh_cache(cwd).await {
            return Ok(discovered);
        }
        let executable = self.installation.launchable().map_err(RuntimeError::new)?;
        let discovered = discover_models(executable, cwd)
            .await
            .map_err(|error| RuntimeError::new(format!("model discovery failed: {error}")))?;
        let mut cache = self.catalog_cache.write().await;
        if cache.len() >= MAX_CACHED_WORKSPACES && !cache.contains_key(cwd) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.fetched_at)
                .map(|(path, _)| path.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(
            cwd.to_path_buf(),
            CatalogCacheEntry {
                fetched_at: Instant::now(),
                discovered: discovered.clone(),
            },
        );
        Ok(discovered)
    }

    async fn fresh_cache(&self, cwd: &Path) -> Option<DiscoveredModels> {
        self.catalog_cache
            .read()
            .await
            .get(cwd)
            .filter(|entry| entry.fetched_at.elapsed() < CATALOG_TTL)
            .map(|entry| entry.discovered.clone())
    }

    async fn refresh_lock(&self, cwd: &Path) -> Arc<Mutex<()>> {
        let mut refreshes = self.catalog_refreshes.lock().await;
        refreshes.retain(|_, refresh| refresh.strong_count() > 0);
        if let Some(refresh) = refreshes.get(cwd).and_then(Weak::upgrade) {
            return refresh;
        }
        let refresh = Arc::new(Mutex::new(()));
        refreshes.insert(cwd.to_path_buf(), Arc::downgrade(&refresh));
        refresh
    }

    fn discovered_catalog(&self, discovered: DiscoveredModels) -> ProviderCatalogEntry {
        let agent = self.installation.agent();
        self.with_icon(ProviderCatalogEntry {
            id: agent.id.clone(),
            label: agent.name.clone(),
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            models: discovered.models,
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: Some(discovered.default_model),
        })
    }

    fn unavailable_catalog(&self, message: impl AsRef<str>) -> ProviderCatalogEntry {
        self.with_icon(ProviderCatalogEntry::unavailable(
            self.installation.provider_id(),
            self.installation.agent().name.clone(),
            message.as_ref(),
        ))
    }

    fn with_icon(&self, mut entry: ProviderCatalogEntry) -> ProviderCatalogEntry {
        entry.icon_data = self.installation.icon_data().map(str::to_string);
        entry
    }
}

#[async_trait]
impl AgentRuntimeAdapter for GenericAcpAdapter {
    /// Identity comes from the portable registry entry; availability comes from
    /// the host's compatibility check. A quarantined install stays in the
    /// catalog as unavailable with its reason attached rather than vanishing.
    fn catalog_entry(&self) -> ProviderCatalogEntry {
        match self.installation.quarantine() {
            Some(quarantine) => self.unavailable_catalog(&quarantine.message),
            None => self.unavailable_catalog("provider model discovery has not completed"),
        }
    }

    async fn catalog_entry_live_for_cwd(&self, cwd: Option<&Path>) -> ProviderCatalogEntry {
        if self.installation.quarantine().is_some() {
            return self.catalog_entry();
        }
        let fallback_cwd;
        let cwd = match cwd {
            Some(cwd) => cwd,
            None => {
                fallback_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
                &fallback_cwd
            }
        };
        match self.discover_for_cwd(cwd).await {
            Ok(discovered) => self.discovered_catalog(discovered),
            Err(error) => self.unavailable_catalog(error.to_string()),
        }
    }

    fn is_valid_resume_session_id(&self, session_id: &str) -> bool {
        !session_id.is_empty()
    }

    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id
            .filter(|session_id| self.is_valid_resume_session_id(session_id))
            .map(ToOwned::to_owned)
    }

    fn persistable_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        self.capabilities
            .supports_durable_resume()
            .then(|| self.resolve_resume_session_id(runtime_session_id))
            .flatten()
    }

    /// Read back the runtime's own provider-neutral permission envelope so
    /// standard ACP `session/request_permission` prompts reach the user.
    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        parse_acp_permission_request(raw, None)
    }

    /// Exec the program directly with its argument vector.
    ///
    /// This is a deliberate divergence from the built-in ACP adapters, which
    /// launch through `cli_discovery::login_shell_exec_command` (`$SHELL -l -c
    /// "exec …"`). `BOUNDARIES.md` Phase 8 requires that marketplace data never
    /// be interpolated into a shell command, and a descriptor is marketplace
    /// data; the service already hydrates its own environment from the login
    /// shell at startup (`shared::login_env`), so the child still inherits a
    /// terminal-like `PATH` without a shell in between. Do not "fix" this to
    /// match the built-ins.
    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        let executable = self.installation.launchable().map_err(RuntimeError::new)?;
        if config.cwd.as_os_str().is_empty() {
            return Err(RuntimeError::new(
                "an ACP session needs a workspace directory",
            ));
        }
        let selected_model = config.model.as_deref().ok_or_else(|| {
            RuntimeError::new("installed providers require an explicit model before session start")
        })?;
        let discovered = self.discover_for_cwd(&config.cwd).await?;
        if !discovered
            .models
            .iter()
            .any(|model| model.id == selected_model)
        {
            return Err(RuntimeError::new(format!(
                "selected model `{selected_model}` is not in the provider's current model catalog"
            )));
        }
        let mut command = tokio::process::Command::new(&executable.command);
        command
            .arg("run")
            .arg("--protocol")
            .arg("acp-v1")
            .args(&executable.args);
        command.current_dir(&config.cwd);
        for (key, value) in &executable.env {
            command.env(key, value);
        }
        // Caller-supplied env wins over the descriptor's, matching how the
        // built-in ACP adapters let a spawn override their defaults.
        if let Some(env) = config.env.as_ref() {
            for (key, value) in env {
                command.env(key, value);
            }
        }
        spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
            command,
            spawn_guard: None,
            client_info: AcpClientInfo::default(),
            config,
            initial_content: content,
            // Context window is reported by the agent through `usage_update`;
            // there is nothing to pre-seed it from.
            context_window: None,
            hooks: Arc::new(InstalledAcpHooks::new(
                discovered.config_id,
                Arc::clone(&self.capabilities),
            )),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{descriptor, descriptor_json, runnable_binary};
    use super::GenericAcpAdapter;
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, RuntimeAccessMode, RuntimePermissionMode, RuntimeSpawnConfig,
        RuntimeUserShellStrategy,
    };
    use crate::domain::agents::providers::installed::installation::HostInstallation;
    use crate::domain::agents::runtime::ProviderStatus;
    use serde_json::json;
    use std::path::Path;
    use std::sync::Arc;

    fn adapter(command: &str) -> GenericAcpAdapter {
        let installation = HostInstallation::from_descriptor(
            descriptor(descriptor_json("acme-agent", command)),
            Path::new("/p/acme-agent.json"),
        )
        .expect("valid descriptor");
        GenericAcpAdapter::new(Arc::new(installation))
    }

    #[test]
    fn catalog_identity_comes_from_the_portable_entry() {
        let dir = tempfile::tempdir().unwrap();
        let entry = adapter(&runnable_binary(dir.path())).catalog_entry();
        assert_eq!(entry.id, "acme-agent");
        assert_eq!(entry.label, "acme-agent agent");
        assert_eq!(entry.status, ProviderStatus::Unavailable);
        assert!(entry
            .status_message
            .expect("cold catalogs explain why they are unavailable")
            .contains("model discovery"));
    }

    #[test]
    fn catalog_carries_a_connector_owned_icon_without_a_local_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        let mut value = descriptor_json("acme-agent", &runnable_binary(dir.path()));
        value["agent"]["icon"] = json!("icon.svg");
        value["installation"]["assets"] = json!({ "directory": dir.path().to_string_lossy() });
        let installation =
            HostInstallation::from_descriptor(descriptor(value), Path::new("/p/acme-agent.json"))
                .expect("valid descriptor");

        let entry = GenericAcpAdapter::new(Arc::new(installation)).catalog_entry();

        assert!(entry
            .icon_data
            .is_some_and(|data| data.starts_with("data:image/svg+xml;base64,")));
    }

    #[tokio::test]
    async fn live_catalog_comes_from_the_provider_models_command() {
        let dir = tempfile::tempdir().unwrap();
        let entry = adapter(&runnable_binary(dir.path()))
            .catalog_entry_live_for_cwd(Some(dir.path()))
            .await;
        assert_eq!(entry.status, ProviderStatus::Available);
        assert_eq!(entry.models.len(), 1);
        assert_eq!(entry.models[0].id, "fixture/default");
        assert!(entry.modes.is_empty());
        assert!(entry.access_modes.is_empty());
        assert_eq!(entry.default_model.as_deref(), Some("fixture/default"));
    }

    #[tokio::test]
    async fn model_catalog_cache_keeps_independent_workspaces() {
        let binary_dir = tempfile::tempdir().unwrap();
        let first_cwd = tempfile::tempdir().unwrap();
        let second_cwd = tempfile::tempdir().unwrap();
        let adapter = adapter(&runnable_binary(binary_dir.path()));

        adapter.discover_for_cwd(first_cwd.path()).await.unwrap();
        adapter.discover_for_cwd(second_cwd.path()).await.unwrap();

        assert!(adapter.fresh_cache(first_cwd.path()).await.is_some());
        assert!(adapter.fresh_cache(second_cwd.path()).await.is_some());
    }

    #[test]
    fn quarantined_installs_stay_in_the_catalog_as_unavailable() {
        let entry = adapter("/nonexistent/cadencr/acme").catalog_entry();
        assert_eq!(entry.id, "acme-agent");
        assert_eq!(entry.status, ProviderStatus::Unavailable);
        assert!(entry
            .status_message
            .expect("a quarantined install must explain itself")
            .contains("/nonexistent/cadencr/acme"));
    }

    #[tokio::test]
    async fn spawning_a_quarantined_install_fails_with_its_stable_code() {
        let result = adapter("/nonexistent/cadencr/acme")
            .spawn(
                json!("hello"),
                RuntimeSpawnConfig {
                    cwd: std::env::temp_dir(),
                    ..RuntimeSpawnConfig::default()
                },
            )
            .await;
        let Err(error) = result else {
            panic!("a quarantined install must not launch");
        };
        assert!(
            error.to_string().contains("EXECUTABLE_NOT_FOUND"),
            "{error}"
        );
    }

    /// A stored ID survives capability discovery so an unsupported resume
    /// fails in the ACP handshake, while new IDs are persisted only after the
    /// connector advertised `loadSession`.
    #[tokio::test]
    async fn separates_stored_resume_validation_from_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = adapter(&runnable_binary(dir.path()));
        assert!(adapter.is_valid_resume_session_id("ses-1"));
        assert_eq!(
            adapter.resolve_resume_session_id(Some("ses-1")).as_deref(),
            Some("ses-1")
        );
        assert_eq!(adapter.persistable_resume_session_id(Some("ses-1")), None);
        assert!(adapter.session_branching().is_none());
        assert!(adapter.compaction_strategy().is_none());
        assert!(!adapter.supports_builtin_compact_command());
        assert!(!adapter.supports_prompt_receipts());
        assert!(!adapter.supports_runtime_slash_command_refresh());
        assert!(adapter.worktree_config_paths().is_empty());
        assert!(adapter.access_mode_setting_key().is_none());
        assert_eq!(
            adapter.user_shell_strategy(),
            RuntimeUserShellStrategy::Unsupported
        );
        for mode in [
            RuntimePermissionMode::Default,
            RuntimePermissionMode::Plan,
            RuntimePermissionMode::BypassPermissions,
        ] {
            assert!(!adapter.supports_permission_mode(&mode));
        }
        assert!(!adapter.supports_access_mode(&RuntimeAccessMode::FullAccess));
        assert!(adapter.default_model_id().await.is_none());
    }

    #[test]
    fn permission_envelopes_are_parsed_generically() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = adapter(&runnable_binary(dir.path()));
        let parsed = adapter
            .parse_permission_request(&json!({
                "type": "acp_permission_request",
                "request_id": "req-1",
                "tool_name": "Bash",
                "tool_input": { "command": "ls" },
                "options": [{
                    "decision": "allow_once",
                    "option_id": "allow",
                    "label": "Allow",
                    "description": "once",
                    "collect_feedback": false
                }],
            }))
            .expect("standard envelope should parse");
        assert_eq!(parsed.request_id, "req-1");
        assert_eq!(parsed.options.len(), 1);
        assert!(adapter
            .parse_permission_request(&json!({ "type": "other" }))
            .is_none());
    }

    #[tokio::test]
    async fn spawning_without_a_workspace_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let result = adapter(&runnable_binary(dir.path()))
            .spawn(json!("hello"), RuntimeSpawnConfig::default())
            .await;
        let Err(error) = result else {
            panic!("an ACP session needs a cwd");
        };
        assert!(error.to_string().contains("workspace directory"), "{error}");
    }
}
