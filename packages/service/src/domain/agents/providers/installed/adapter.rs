//! The provider-neutral runtime adapter for code-backed provider packages.
//!
//! The descriptor supplies identity and an executable, never model data. The
//! executable owns provider-specific discovery/parsing through its mandatory
//! `models` command; ACP remains the live session protocol.

mod capabilities;

use std::borrow::Cow;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::domain::agents::acp::runtime::permission_events::parse_acp_permission_request;
use crate::domain::agents::acp::runtime::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
use crate::domain::agents::acp::{AcpClientInfo, AcpStderrPolicy};
use crate::domain::agents::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeAccessMode, RuntimeAccessModeChange,
    RuntimeCompactionStrategy, RuntimeError, RuntimePermissionMode, RuntimePermissionRequest,
    RuntimePromptAttachment, RuntimeSlashCommand, RuntimeSpawnConfig,
};
use crate::domain::agents::runtime::{
    ProviderCatalogEntry, ProviderPromptCapabilities, ProviderResumeCommand, ProviderStatus,
};

use super::hooks::InstalledAcpHooks;
use super::host_integration::HostIntegrationCache;
use super::installation::HostInstallation;
use super::model_discovery::{discover_models, DiscoveredModels, ProviderModeMap};
use super::prompt_capabilities::SharedPromptCapabilities;
use super::provider_command::{prepare_provider_command, PreparedProviderCommand};
use super::slash_commands::SlashCommandCatalog;
use super::workspace_cache::WorkspaceCache;

const CATALOG_TTL: Duration = Duration::from_secs(30);

pub struct GenericAcpAdapter {
    installation: Arc<HostInstallation>,
    catalog_cache: WorkspaceCache<PathBuf, DiscoveredModels>,
    /// Modes from the most recent `models` run. Mode and access checks are
    /// synchronous trait calls, so they read this snapshot.
    last_modes: std::sync::RwLock<Arc<ProviderModeMap>>,
    host_integration: Arc<HostIntegrationCache>,
    slash_commands: Arc<SlashCommandCatalog>,
    prompt_capabilities: SharedPromptCapabilities,
}

impl GenericAcpAdapter {
    pub fn new(installation: Arc<HostInstallation>) -> Self {
        let host_integration = Arc::new(HostIntegrationCache::new(installation.provider_id()));
        Self {
            installation,
            catalog_cache: WorkspaceCache::default(),
            last_modes: std::sync::RwLock::new(Arc::default()),
            host_integration,
            slash_commands: Arc::default(),
            prompt_capabilities: SharedPromptCapabilities::default(),
        }
    }

    /// Shared with the connector updater, which invalidates it after an update.
    pub fn host_integration(&self) -> Arc<HostIntegrationCache> {
        Arc::clone(&self.host_integration)
    }

    /// Shared with the connector updater (invalidation) and with each live
    /// session's hooks (`available_commands_update` snapshots).
    pub fn slash_commands(&self) -> Arc<SlashCommandCatalog> {
        Arc::clone(&self.slash_commands)
    }

    fn modes(&self) -> Arc<ProviderModeMap> {
        self.last_modes
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn observe_modes(&self, discovered: &DiscoveredModels) {
        *self
            .last_modes
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(discovered.modes.clone());
    }

    async fn discover_for_cwd(&self, cwd: &Path) -> Result<DiscoveredModels, RuntimeError> {
        self.catalog_cache
            .get_or_refresh(&cwd.to_path_buf(), || async {
                let executable = self.installation.launchable().map_err(RuntimeError::new)?;
                let discovered = discover_models(executable, cwd).await.map_err(|error| {
                    RuntimeError::new(format!("model discovery failed: {error}"))
                })?;
                self.observe_modes(&discovered);
                Ok((discovered, CATALOG_TTL))
            })
            .await
    }

    fn discovered_catalog(&self, discovered: DiscoveredModels) -> ProviderCatalogEntry {
        let agent = self.installation.agent();
        self.with_icon(ProviderCatalogEntry {
            id: agent.id.clone(),
            label: agent.name.clone(),
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            modes: discovered.modes.mode_catalog(),
            access_modes: discovered.modes.access_mode_catalog(),
            models: discovered.models,
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
        self.host_integration
            .ensure_loaded(&self.installation)
            .await;
        match self.discover_for_cwd(cwd).await {
            Ok(discovered) => self.discovered_catalog(discovered),
            Err(error) => self.unavailable_catalog(error.to_string()),
        }
    }

    fn spawn_startup_warmup(&self) {
        let cache = self.host_integration();
        let installation = Arc::clone(&self.installation);
        tokio::spawn(async move {
            cache.ensure_loaded(&installation).await;
        });
    }

    fn worktree_config_paths(&self) -> Vec<Cow<'static, str>> {
        capabilities::worktree_config_paths(&self.host_integration.current())
    }

    async fn on_worktree_created(
        &self,
        source_project_path: &Path,
        worktree_path: &Path,
    ) -> Result<(), RuntimeError> {
        let integration = self
            .host_integration
            .ensure_loaded(&self.installation)
            .await;
        capabilities::copy_worktree_config(
            &self.installation.agent().name,
            &integration,
            source_project_path,
            worktree_path,
        )
        .await
    }

    fn compaction_strategy(&self) -> Option<RuntimeCompactionStrategy> {
        capabilities::compaction_strategy(&self.host_integration.current())
    }

    fn resume_command(&self) -> Option<ProviderResumeCommand> {
        self.host_integration.current().resume_command.clone()
    }

    /// The package's `slash-commands` listing for `cwd` plus what the last
    /// live session there advertised (see `slash_commands.rs`).
    async fn runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        self.slash_commands.commands(&self.installation, cwd).await
    }

    fn prompt_capabilities(&self) -> Option<ProviderPromptCapabilities> {
        self.prompt_capabilities.current()
    }

    fn prompt_attachment_block(&self, attachment: &RuntimePromptAttachment<'_>) -> Value {
        capabilities::prompt_attachment_block(attachment)
    }

    fn supports_permission_mode(&self, mode: &RuntimePermissionMode) -> bool {
        self.modes().mode_for(mode).is_some()
    }

    /// The provider's primary edit mode (its first mapped mode value).
    fn default_permission_mode_wire(&self) -> Cow<'static, str> {
        capabilities::default_permission_mode_wire(&self.modes())
    }

    fn supports_access_mode(&self, mode: &RuntimeAccessMode) -> bool {
        self.modes().access_mode_for(mode).is_some()
    }

    fn access_mode_setting_key(&self) -> Option<Cow<'static, str>> {
        capabilities::access_mode_setting_key(self.installation.provider_id(), &self.modes())
    }

    /// Access modes are live config options (`session/set_config_option`):
    /// the connector restarts its own agent when the launch flags differ,
    /// while a host respawn would reload a session not saved yet.
    fn access_mode_change(&self) -> RuntimeAccessModeChange {
        if self.modes().access_modes.is_empty() {
            RuntimeAccessModeChange::Respawn
        } else {
            RuntimeAccessModeChange::Live
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

    /// Read back the runtime's own provider-neutral permission envelope so
    /// standard ACP `session/request_permission` prompts reach the user.
    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        parse_acp_permission_request(raw)
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
        let integration = self
            .host_integration
            .ensure_loaded(&self.installation)
            .await;
        let hooks = InstalledAcpHooks::builder()
            .model_config_id(discovered.config_id)
            .modes(Arc::new(discovered.modes))
            .maybe_compact_command(integration.compact_command.clone())
            .prompt_capabilities(self.prompt_capabilities.clone())
            .slash_commands(self.slash_commands())
            .build();
        let args = [
            OsString::from("run"),
            OsString::from("--protocol"),
            OsString::from("acp-v1"),
        ];
        let PreparedProviderCommand {
            command,
            process_tree_policy,
        } = prepare_provider_command(executable, &args, &config.cwd, config.env.as_ref())
            .await
            .map_err(|error| {
                RuntimeError::new(format!(
                    "could not prepare installed provider runtime: {error}"
                ))
            })?;
        spawn_acp_runtime_session(AcpRuntimeSpawnArgs {
            command,
            spawn_guard: None,
            client_info: AcpClientInfo::default(),
            stderr_policy: AcpStderrPolicy::Discard,
            process_tree_policy,
            config,
            initial_content: content,
            // Context window is reported by the agent through `usage_update`;
            // there is nothing to pre-seed it from.
            context_window: None,
            hooks: Arc::new(hooks),
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_fixtures::{descriptor, descriptor_json, runnable_binary};
    use super::GenericAcpAdapter;
    use crate::domain::agents::adapter::{
        AgentRuntimeAdapter, RuntimeAccessMode, RuntimeAccessModeChange, RuntimePermissionMode,
        RuntimeSpawnConfig, RuntimeUserShellStrategy,
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

    /// A connector declaring modes, access modes and a host integration
    /// drives every capability the trait exposes, from data alone.
    #[tokio::test]
    async fn declared_modes_and_host_integration_become_adapter_capabilities() {
        let dir = tempfile::tempdir().unwrap();
        let script = super::super::test_fixtures::write_script(
            dir.path(),
            "declaring-agent",
            r#"#!/bin/sh
if [ "$1" = "models" ]; then
  cat <<'JSON'
[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","options":[{"value":"m","name":"M"}]},
 {"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"agent","options":[
   {"value":"agent","name":"Agent","_meta":{"cadencr":{"permissionMode":"default"}}},
   {"value":"plan","name":"Plan","description":"Read only","_meta":{"cadencr":{"permissionMode":"plan"}}}]},
 {"id":"sandbox","name":"Sandbox","type":"select","currentValue":"on","_meta":{"cadencr":{"role":"access_mode"}},"options":[
   {"value":"on","name":"Default","_meta":{"cadencr":{"accessMode":"default"}}},
   {"value":"off","name":"Full access","_meta":{"cadencr":{"accessMode":"fullAccess"}}}]}]
JSON
  exit 0
fi
if [ "$1" = "host-integration" ]; then
  echo '{"compactCommand":"compress","worktreeConfigPaths":[".acme/rules"],"resumeCommand":{"program":"acme","args":["--resume","{session_id}"]}}'
  exit 0
fi
exit 1
"#,
        );
        let adapter = adapter(&script.to_string_lossy());
        assert!(!adapter.supports_permission_mode(&RuntimePermissionMode::Plan));
        let entry = adapter.catalog_entry_live_for_cwd(Some(dir.path())).await;
        assert_eq!(entry.status, ProviderStatus::Available);
        let modes: Vec<_> = entry.modes.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(modes, ["default", "plan"]);
        assert_eq!(entry.modes[1].description.as_deref(), Some("Read only"));
        let access: Vec<_> = entry.access_modes.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(access, ["default", "fullAccess"]);

        assert!(adapter.supports_permission_mode(&RuntimePermissionMode::Plan));
        assert!(!adapter.supports_permission_mode(&RuntimePermissionMode::AcceptEdits));
        assert_eq!(adapter.default_permission_mode_wire(), "default");
        assert!(adapter.supports_access_mode(&RuntimeAccessMode::FullAccess));
        assert!(!adapter.supports_access_mode(&RuntimeAccessMode::AutoReview));
        assert_eq!(
            adapter.access_mode_setting_key().as_deref(),
            Some("provider_access_mode.acme-agent")
        );
        assert_eq!(adapter.access_mode_change(), RuntimeAccessModeChange::Live);
        assert!(adapter.compaction_strategy().is_some());
        assert!(adapter.supports_builtin_compact_command());
        assert_eq!(adapter.worktree_config_paths(), [".acme/rules"]);
        let resume = adapter.resume_command().expect("declared resume command");
        assert_eq!(resume.program, "acme");
        assert_eq!(resume.args, ["--resume", "{session_id}"]);
        assert!(adapter.prompt_capabilities().is_none());
    }

    #[tokio::test]
    async fn model_catalog_cache_keeps_independent_workspaces() {
        let binary_dir = tempfile::tempdir().unwrap();
        let first_cwd = tempfile::tempdir().unwrap();
        let second_cwd = tempfile::tempdir().unwrap();
        let adapter = adapter(&runnable_binary(binary_dir.path()));

        adapter.discover_for_cwd(first_cwd.path()).await.unwrap();
        adapter.discover_for_cwd(second_cwd.path()).await.unwrap();

        for cwd in [first_cwd.path(), second_cwd.path()] {
            let cached = adapter.catalog_cache.fresh(&cwd.to_path_buf()).await;
            assert!(cached.is_some(), "{}", cwd.display());
        }
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
    /// fails explicitly in the ACP handshake rather than silently starting a
    /// new session. Live persistence eligibility belongs to the spawned runtime.
    #[tokio::test]
    async fn stored_resume_validation_remains_adapter_owned() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = adapter(&runnable_binary(dir.path()));
        assert!(adapter.is_valid_resume_session_id("ses-1"));
        assert_eq!(
            adapter.resolve_resume_session_id(Some("ses-1")).as_deref(),
            Some("ses-1")
        );
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
