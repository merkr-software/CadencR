//! The provider-neutral runtime adapter for code-backed provider packages.
//!
//! The descriptor supplies identity and an executable, never model data. The
//! executable owns provider-specific discovery/parsing through its mandatory
//! `models` command; ACP remains the live session protocol.

mod capabilities;
mod catalog;

use catalog::{default_cwd, discover_cached, with_installation_icon};

use std::borrow::Cow;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

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
use crate::domain::agents::catalog_cache::{CatalogProvider, LiveCatalogCache};
use crate::domain::agents::runtime::{
    ProviderCatalogEntry, ProviderPromptCapabilities, ProviderResumeCommand,
};

use super::hooks::InstalledAcpHooks;
use super::host_integration::HostIntegrationCache;
use super::installation::HostInstallation;
use super::model_discovery::{DiscoveredModels, ProviderModeMap};
use super::prompt_capabilities::SharedPromptCapabilities;
use super::provider_command::{prepare_provider_command, PreparedProviderCommand};
use super::slash_commands::SlashCommandCatalog;

type InstalledCatalogCache = LiveCatalogCache<PathBuf, Option<DiscoveredModels>>;

/// Synchronous adapter controls from the most recent successful discovery.
#[derive(Default)]
struct DiscoveredControls {
    modes: Arc<ProviderModeMap>,
    prompt_steering: bool,
}

pub struct GenericAcpAdapter {
    installation: Arc<HostInstallation>,
    session_scope: Result<Option<super::managed::ManagedSessionScope>, String>,
    catalog_cache: Arc<InstalledCatalogCache>,
    controls: Arc<RwLock<DiscoveredControls>>,
    host_integration: Arc<HostIntegrationCache>,
    slash_commands: Arc<SlashCommandCatalog>,
    prompt_capabilities: SharedPromptCapabilities,
}

impl GenericAcpAdapter {
    pub fn new(installation: Arc<HostInstallation>) -> Self {
        let host_integration = Arc::new(HostIntegrationCache::new(installation.provider_id()));
        let session_scope =
            super::managed::ManagedSessionScope::load(&installation.executable().command);
        let agent = installation.agent();
        let catalog_cache = Arc::new(LiveCatalogCache::new(CatalogProvider::owned(
            agent.id.clone(),
            agent.name.clone(),
            agent.name.clone(),
        )));
        Self {
            session_scope,
            installation,
            catalog_cache,
            controls: Arc::default(),
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
        self.controls
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .modes
            .clone()
    }
}

#[async_trait]
impl AgentRuntimeAdapter for GenericAcpAdapter {
    fn supports_prompt_receipts(&self) -> bool {
        self.controls
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .prompt_steering
    }

    fn prompt_receipts_at_submission(&self) -> bool {
        self.supports_prompt_receipts()
    }

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
                fallback_cwd = default_cwd();
                &fallback_cwd
            }
        };
        let (_, cached) = tokio::join!(
            self.host_integration.ensure_loaded(&self.installation),
            self.cached_catalog_for_cwd(cwd),
        );
        with_installation_icon(&self.installation, (*cached.catalog).clone())
    }

    fn spawn_startup_warmup(&self) {
        if self.installation.quarantine().is_some() {
            return;
        }
        let cache = self.host_integration();
        let installation = Arc::clone(&self.installation);
        let catalog_cache = Arc::clone(&self.catalog_cache);
        let controls = Arc::clone(&self.controls);
        tokio::spawn(async move {
            let cwd = default_cwd();
            let _ = tokio::join!(
                cache.ensure_loaded(&installation),
                discover_cached(&catalog_cache, &installation, &controls, &cwd),
            );
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
        let mut command = self.host_integration.current().resume_command.clone()?;
        command.session_owner = self
            .session_scope
            .as_ref()
            .ok()?
            .as_ref()
            .and_then(|scope| scope.owner().map(ToOwned::to_owned));
        Some(command)
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

    async fn resolve_initial_permission_mode(
        &self,
        cwd: &Path,
        requested: Option<&str>,
    ) -> Result<Option<RuntimePermissionMode>, RuntimeError> {
        use crate::domain::agents::permission_modes::parse_permission_mode;
        let discovered = self.discover_for_cwd(cwd).await?;
        let modes = &discovered.modes;
        Ok(requested
            .map(parse_permission_mode)
            .filter(|mode| modes.mode_for(mode).is_some())
            .or_else(|| {
                modes
                    .primary_mode()
                    .map(|mode| parse_permission_mode(&mode.host_id))
            }))
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

    fn resume_session_rejection(&self, session_id: &str) -> Option<String> {
        match &self.session_scope {
            Err(error) => Some(error.clone()),
            Ok(Some(scope)) => scope.native(session_id).err(),
            Ok(None) => None,
        }
    }

    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id
            .filter(|id| !id.is_empty() && self.resume_session_rejection(id).is_none())
            .map(ToOwned::to_owned)
    }

    fn persistable_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        let native = runtime_session_id.filter(|id| !id.is_empty())?;
        match &self.session_scope {
            Ok(Some(scope)) => Some(scope.bind(native)),
            Ok(None) => Some(native.into()),
            Err(_) => None,
        }
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
        mut config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        let scope = self.session_scope.as_ref().map_err(RuntimeError::new)?;
        if let (Some(scope), Some(persisted)) = (scope, config.resume_session_id.as_deref()) {
            config.resume_session_id = Some(scope.native(persisted).map_err(RuntimeError::new)?);
        }
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
        if config.validate_restored_permission_mode {
            if discovered.modes.primary_mode().is_none() {
                // Older hosts persisted seeds even for providers without a
                // mapped mode. In that case the native session owns its mode.
                config.permission_mode = None;
            } else if config
                .permission_mode
                .as_ref()
                .is_none_or(|mode| discovered.modes.mode_for(mode).is_none())
            {
                return Err(RuntimeError::new(
                    "saved permission mode is unavailable in this workspace; choose an available mode and resend",
                ));
            }
        }
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
            .exclude_launcher_ports(integration.exclude_launcher_ports)
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
            wire_transform: None,
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
        let adapter = adapter(&runnable_binary(dir.path()));
        let entry = adapter.catalog_entry_live_for_cwd(Some(dir.path())).await;
        assert_eq!(entry.status, ProviderStatus::Available);
        assert_eq!(entry.models.len(), 1);
        assert_eq!(entry.models[0].id, "fixture/default");
        assert!(entry.modes.is_empty());
        assert!(entry.access_modes.is_empty());
        assert_eq!(entry.default_model.as_deref(), Some("fixture/default"));
        assert!(!adapter.prompt_receipts_at_submission());
    }

    #[tokio::test]
    async fn warmup_sets_steering_and_an_unavailable_workspace_keeps_the_last_good_capability() {
        let dir = tempfile::tempdir().unwrap();
        let script = super::super::test_fixtures::write_script(
            dir.path(),
            "warmup-steering",
            r#"#!/bin/sh
if [ "$1" = "models" ]; then
    echo '[{"id":"model","name":"Model","type":"select","category":"model","currentValue":"m","options":[{"value":"m","name":"M"}],"_meta":{"cadencr":{"promptSteering":true}}}]'
else
    echo '{}'
fi
"#,
        );
        let adapter = adapter(&script.to_string_lossy());
        adapter.spawn_startup_warmup();
        let cwd = super::default_cwd();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while adapter.catalog_cache.cached(&cwd).await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("startup discovery should finish");
        assert!(
            adapter.supports_prompt_receipts(),
            "warmup publishes the capability"
        );
        let unavailable = dir.path().join("missing");
        let entry = adapter.catalog_entry_live_for_cwd(Some(&unavailable)).await;
        assert_eq!(entry.status, ProviderStatus::Unavailable);
        assert!(
            adapter.supports_prompt_receipts(),
            "an unrelated probe failure cannot revoke steering"
        );
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
[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","_meta":{"cadencr":{"promptSteering":true}},"options":[{"value":"m","name":"M"}]},
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
        assert!(!adapter.prompt_receipts_at_submission());
        let entry = adapter.catalog_entry_live_for_cwd(Some(dir.path())).await;
        assert_eq!(entry.status, ProviderStatus::Available);
        assert!(adapter.supports_prompt_receipts());
        assert!(adapter.prompt_receipts_at_submission());
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
            let cached = adapter.catalog_cache.cached(&cwd.to_path_buf()).await;
            assert!(
                cached.is_some_and(|entry| entry.is_fresh()),
                "{}",
                cwd.display()
            );
        }
    }

    #[tokio::test]
    async fn expired_model_catalog_serves_stale_entry_immediately_while_refreshing() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path().join("runs");
        let gate = dir.path().join("gate");
        let script = super::super::test_fixtures::write_script(
            dir.path(),
            "swr-agent",
            &format!(
                "#!/bin/sh\nif [ \"$1\" != \"models\" ]; then exit 1; fi\necho run >> '{}'\nwhile [ -f '{}' ]; do sleep 0.02; done\ncat <<'JSON'\n[{{\"id\":\"model\",\"name\":\"Model\",\"category\":\"model\",\"type\":\"select\",\"currentValue\":\"m\",\"options\":[{{\"value\":\"m\",\"name\":\"M\"}}]}}]\nJSON\n",
                runs.display(),
                gate.display(),
            ),
        );
        let adapter = adapter(&script.to_string_lossy());
        let cwd = dir.path();

        let initial = adapter.catalog_entry_live_for_cwd(Some(cwd)).await;
        assert_eq!(initial.status, ProviderStatus::Available);
        assert_eq!(std::fs::read_to_string(&runs).unwrap().lines().count(), 1);

        // Hold subsequent probes behind `gate` and expire the cached entry: a
        // read within MAX_STALE must return the cached catalog while the
        // background probe is still gated.
        std::fs::write(&gate, "").unwrap();
        adapter
            .catalog_cache
            .force_expire_for_test(&cwd.to_path_buf())
            .await;

        let stale = adapter.catalog_entry_live_for_cwd(Some(cwd)).await;
        assert!(gate.exists(), "stale read must return while probe is gated");
        assert_eq!(stale.status, ProviderStatus::Available);
        assert_eq!(stale.default_model.as_deref(), Some("m"));

        std::fs::remove_file(&gate).unwrap();
        for _ in 0..100 {
            if std::fs::read_to_string(&runs).unwrap().lines().count() >= 2 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("background catalog refresh never ran");
    }

    #[tokio::test]
    async fn initial_permission_mode_uses_the_requested_workspace() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(first.path().join("allow-auto"), "").unwrap();
        let script = super::super::test_fixtures::write_script(
            first.path(),
            "workspace-modes",
            r#"#!/bin/sh
cat <<'JSON'
[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","options":[{"value":"m","name":"M"}]},
 {"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"default","options":[
   {"value":"default","name":"Default","_meta":{"cadencr":{"permissionMode":"default"}}}
JSON
if [ -f ./allow-auto ]; then
  echo ',{"value":"auto","name":"Auto","_meta":{"cadencr":{"permissionMode":"auto"}}}'
fi
echo ']}]'
"#,
        );
        let adapter = adapter(script.to_str().unwrap());
        for (cwd, expected) in [
            (first.path(), RuntimePermissionMode::Auto),
            (second.path(), RuntimePermissionMode::Default),
            (first.path(), RuntimePermissionMode::Auto),
        ] {
            assert_eq!(
                adapter
                    .resolve_initial_permission_mode(cwd, Some("auto"))
                    .await
                    .unwrap(),
                Some(expected)
            );
        }
    }

    #[tokio::test]
    async fn a_deferred_mode_is_validated_when_discovery_recovers_with_mapped_modes() {
        let workspace = tempfile::tempdir().unwrap();
        let cwd = workspace.path();
        let script = super::super::test_fixtures::write_script(
            cwd,
            "provider",
            r#"#!/bin/sh
if [ "$1" = "run" ]; then
  touch ./runtime-started
  exit 2
fi
if [ "$1" != "models" ]; then exit 2; fi
touch ./discovery-called
if [ ! -f ./online ]; then exit 2; fi
if [ -f ./no-mapped-modes ]; then
  echo '[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","options":[{"value":"m","name":"M"}]}]'
  exit 0
fi
cat <<'JSON'
[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","options":[{"value":"m","name":"M"}]},
 {"id":"mode","name":"Mode","category":"mode","type":"select","currentValue":"default","options":[
   {"value":"default","name":"Default","_meta":{"cadencr":{"permissionMode":"default"}}}
 ]}]
JSON
"#,
        );
        let adapter = adapter(script.to_str().unwrap());
        assert!(adapter
            .resolve_initial_permission_mode(cwd, Some("plan"))
            .await
            .is_err());
        assert!(cwd.join("discovery-called").exists());
        let mut config = RuntimeSpawnConfig {
            cwd: cwd.to_path_buf(),
            model: Some("m".into()),
            resume_session_id: Some("previous-session".into()),
            permission_mode: Some(RuntimePermissionMode::Plan),
            validate_restored_permission_mode: true,
            ..Default::default()
        };
        let error = adapter
            .spawn(json!("hello"), config.clone())
            .await
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("model discovery failed"),
            "{error}"
        );
        assert!(!cwd.join("runtime-started").exists());

        std::fs::write(cwd.join("online"), "").unwrap();
        adapter
            .catalog_cache
            .force_expire_for_test(&cwd.to_path_buf())
            .await;
        let error = adapter
            .spawn(json!("hello"), config.clone())
            .await
            .err()
            .unwrap();
        assert!(
            error
                .to_string()
                .contains("saved permission mode is unavailable"),
            "{error}"
        );
        assert!(!cwd.join("runtime-started").exists());

        config.permission_mode = Some(RuntimePermissionMode::Default);
        assert!(adapter.spawn(json!("hello"), config.clone()).await.is_err());
        assert!(cwd.join("runtime-started").exists());

        // Before mode initialization was validated, even providers without mode
        // mappings could have a stored seed from a client or provider switch.
        std::fs::write(cwd.join("no-mapped-modes"), "").unwrap();
        std::fs::remove_file(cwd.join("runtime-started")).unwrap();
        adapter.catalog_cache.reset_for_test().await;
        config.permission_mode = Some(RuntimePermissionMode::AcceptEdits);
        assert!(adapter.spawn(json!("hello"), config).await.is_err());
        assert!(
            cwd.join("runtime-started").exists(),
            "legacy seed must not block native resume"
        );
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
