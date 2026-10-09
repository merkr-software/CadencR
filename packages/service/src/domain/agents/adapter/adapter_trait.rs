use std::borrow::Cow;
use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use super::branching::SessionBranching;
use super::config::{
    ResolvedRuntimeProfile, RuntimeAccessMode, RuntimeConfigOverrides, RuntimeEffectiveConfig,
    RuntimePermissionMode, RuntimeSpawnConfig,
};
use super::error::RuntimeError;
use super::event_types::RuntimeEvent;
use super::permission::{
    RuntimeCompactionStrategy, RuntimePermissionRequest, RuntimePromptCommandPolicy,
    RuntimeSlashCommand,
};
use super::session::AgentRuntimeSession;
use super::user_shell::RuntimeUserShellStrategy;

#[async_trait]
pub trait AgentRuntimeAdapter: Send + Sync {
    /// Resolve local profile settings for selection, even before the CLI is
    /// installed. The revision may cover only stored settings; runtime launch
    /// refreshes it through `resolve_profile` before using native configuration.
    async fn resolve_profile_for_selection(
        &self,
        selection: Option<&str>,
        cwd: &Path,
    ) -> Result<Option<ResolvedRuntimeProfile>, RuntimeError> {
        self.resolve_profile(selection, cwd).await
    }
    fn supports_profile_config_inheritance(&self) -> bool {
        false
    }
    async fn resolve_profile_effective_config(
        &self,
        _selection: Option<&str>,
        _cwd: &Path,
        overrides: &RuntimeConfigOverrides,
    ) -> Result<RuntimeEffectiveConfig, RuntimeError> {
        Ok(RuntimeEffectiveConfig {
            model: overrides.model.clone(),
            thinking_effort: overrides.thinking_effort.clone(),
            fast_mode: overrides.fast_mode.unwrap_or(false),
        })
    }
    /// Public, secret-free profile metadata for generic selection surfaces.
    async fn profile_catalog(
        &self,
        _cwd: Option<&Path>,
    ) -> Result<Option<super::super::runtime::ProviderProfilesResponse>, RuntimeError> {
        Ok(None)
    }
    /// Resolve a persisted profile selection in provider-owned configuration.
    /// `None` requests the provider's current default. Providers without a
    /// profile concept return `Ok(None)`.
    async fn resolve_profile(
        &self,
        _selection: Option<&str>,
        _cwd: &Path,
    ) -> Result<Option<ResolvedRuntimeProfile>, RuntimeError> {
        Ok(None)
    }
    fn is_valid_resume_session_id(&self, _session_id: &str) -> bool {
        true
    }

    /// Point-in-time context branching (rewind / fork). `None` (the default)
    /// means the provider can't branch; the orchestrator reports the action
    /// unsupported. Providers that can (today: Claude Code) return their impl.
    fn session_branching(&self) -> Option<&dyn SessionBranching> {
        None
    }

    fn parse_permission_request(&self, _raw: &Value) -> Option<RuntimePermissionRequest> {
        None
    }

    /// Whether a rejected runtime permission response should use the legacy channel.
    fn uses_legacy_permission_channel_on_response_error(&self) -> bool {
        false
    }

    /// Resolve a resume session ID from the DB-stored runtime_session_id.
    /// The default accepts any string. Override to apply validation (e.g. UUID-only).
    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id.map(ToOwned::to_owned)
    }

    /// Resolve a newly observed runtime ID that is safe to persist for a later
    /// process. Providers whose resume support is negotiated at runtime can
    /// reject persistence without discarding an already-stored ID that must
    /// fail visibly during the next handshake.
    fn persistable_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        self.resolve_resume_session_id(runtime_session_id)
    }

    /// Static catalog entry (available immediately at startup).
    ///
    /// Model entries are owned by this adapter. Shared legacy resolution uses
    /// exact catalog membership rather than inferring ownership from model-id
    /// spelling.
    fn catalog_entry(&self) -> super::super::runtime::ProviderCatalogEntry;

    /// Canonicalize a requested model id against this provider's catalog.
    ///
    /// The default is provider-neutral and preserves the caller's value.
    /// Providers that support stable aliases can override this without leaking
    /// provider-specific model semantics into shared orchestration code.
    fn canonicalize_model_id(
        &self,
        model_id: &str,
        _catalog: &[super::super::runtime::ModelCatalogEntry],
    ) -> String {
        model_id.to_string()
    }

    /// Live catalog entry (may fetch from external service). Defaults to static.
    async fn catalog_entry_live(&self) -> super::super::runtime::ProviderCatalogEntry {
        self.catalog_entry()
    }

    /// Live catalog entry scoped to a workspace path. Providers whose catalog
    /// includes project-local data (OpenCode agents, commands, etc.) can
    /// override this without forcing global settings pages to pick a cwd.
    async fn catalog_entry_live_for_cwd(
        &self,
        _cwd: Option<&Path>,
    ) -> super::super::runtime::ProviderCatalogEntry {
        self.catalog_entry_live().await
    }

    /// Live catalog entry with persisted settings and an optional provider profile.
    async fn catalog_entry_live_for_settings(
        &self,
        _read_pool: &sqlx::SqlitePool,
        cwd: Option<&Path>,
        _profile: Option<&str>,
    ) -> super::super::runtime::ProviderCatalogEntry {
        self.catalog_entry_live_for_cwd(cwd).await
    }

    /// Extra models contributed by user configuration (e.g. custom Claude Code
    /// model aliases stored in SQLite). Returned entries are merged into the
    /// adapter's catalog; on id collision the user entry wins.
    async fn extra_models(
        &self,
        _read_pool: &sqlx::SqlitePool,
    ) -> Vec<super::super::runtime::ModelCatalogEntry> {
        Vec::new()
    }

    /// Preferred default model id for this provider.
    ///
    /// Defaults to the static catalog entry so shared callers can stay
    /// provider-neutral. Providers with live catalogs (like Claude Code)
    /// should override this.
    async fn default_model_id(&self) -> Option<String> {
        self.catalog_entry().default_model
    }

    /// Preferred default model id with access to persisted settings.
    async fn default_model_id_for_settings(&self, _read_pool: &sqlx::SqlitePool) -> Option<String> {
        self.default_model_id().await
    }

    /// Configured profile to pin on a newly-created session for this provider.
    ///
    /// The profile name is persisted before the runtime is dispatched so a
    /// headless spawn and a concurrently connecting UI reconstruct the same
    /// provider configuration. `None` means the provider has no profile
    /// concept; profile-aware providers may return their reserved built-in
    /// profile name (for example `"default"`).
    fn profile_name_for_new_session(&self) -> Option<String> {
        None
    }

    /// Provider-owned environment for a new host-initiated session.
    fn environment_for_new_session(&self) -> Option<std::collections::HashMap<String, String>> {
        None
    }

    /// Provider-known context window for a given model id, if the provider
    /// can answer synchronously (e.g. opencode exposes this via its server).
    /// Defaults to `None` — callers must fall back to another source
    /// (usually history persisted from prior `result` events).
    async fn context_window_for_model(&self, _model_id: &str) -> Option<u64> {
        None
    }

    /// Whether this adapter knows that `model_id` accepts the supplied
    /// thinking-effort level. `None` means the adapter cannot answer
    /// authoritatively, so callers should preserve existing effort state.
    fn supports_thinking_effort_level(&self, _model_id: &str, _effort: &str) -> Option<bool> {
        None
    }

    /// Whether prompts can be acknowledged when delivered to a live runtime.
    fn supports_prompt_receipts(&self) -> bool {
        false
    }

    /// Extract an authoritative context window for the current event.
    ///
    /// The default implementation stays provider-neutral by relying only on
    /// normalized metadata/init values. Providers with richer wire formats can
    /// override this and inspect their raw payloads in the adapter layer.
    fn context_window_for_event(
        &self,
        runtime_event: &RuntimeEvent,
        _active_model: Option<&str>,
    ) -> Option<u64> {
        runtime_event
            .context_window()
            .or_else(|| runtime_event.init().and_then(|init| init.context_window))
    }

    /// Called once at startup for background warmup (e.g. starting sidecar processes).
    fn spawn_startup_warmup(&self) {}

    /// Provider config paths copied into a new worktree, relative to the project root.
    fn worktree_config_paths(&self) -> Vec<Cow<'static, str>> {
        Vec::new()
    }

    async fn on_worktree_created(
        &self,
        source_project_path: &Path,
        worktree_path: &Path,
    ) -> Result<(), RuntimeError> {
        let paths = self.worktree_config_paths();
        if paths.is_empty() {
            return Ok(());
        }
        super::adapter_defaults::copy_worktree_config(
            &self.catalog_entry().label,
            source_project_path,
            worktree_path,
            &paths,
        )
        .await
    }

    async fn runtime_slash_commands(
        &self,
        _cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        Err(RuntimeError::new(
            "runtime slash command discovery is not supported by this provider",
        ))
    }

    async fn runtime_slash_commands_for_profile(
        &self,
        cwd: &str,
        _profile: Option<&str>,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        self.runtime_slash_commands(cwd).await
    }

    /// Provider-owned syntax for invoking the normalized command catalog.
    /// Shared UI consumes this policy without branching on provider identity.
    fn prompt_command_policy(&self) -> RuntimePromptCommandPolicy {
        RuntimePromptCommandPolicy::default()
    }

    /// Programmatic handling for a leading-`!` user shell command.
    ///
    /// Defaults to unsupported so future providers cannot accidentally execute
    /// commands without making an explicit adapter-level policy choice.
    fn user_shell_strategy(&self) -> RuntimeUserShellStrategy {
        RuntimeUserShellStrategy::Unsupported
    }

    /// Whether slash-command refresh performs a real re-resolve.
    fn supports_runtime_slash_command_refresh(&self) -> bool {
        false
    }

    /// Force a fresh re-resolve of the slash-command catalog.
    async fn refresh_runtime_slash_commands(
        &self,
        _cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        Err(RuntimeError::new(
            "runtime slash command refresh is not supported by this provider",
        ))
    }

    fn compaction_strategy(&self) -> Option<RuntimeCompactionStrategy> {
        None
    }

    fn supports_builtin_compact_command(&self) -> bool {
        self.compaction_strategy().is_some()
    }

    /// Whether this provider's CLI can run a permission mode; `mode.set` rejects
    /// the rest (frontend mirror: `lib/provider-modes.ts`). Defaults to none, so
    /// a new provider never silently accepts modes its CLI can't execute.
    fn supports_permission_mode(&self, _mode: &RuntimePermissionMode) -> bool {
        false
    }

    /// Whether this provider supports the provider-neutral access/autonomy
    /// axis (Default, Full Access, Auto Review). Providers own the concrete
    /// CLI mapping; shared orchestration only persists and transports it.
    fn supports_access_mode(&self, _mode: &RuntimeAccessMode) -> bool {
        false
    }

    /// Workspace setting used as the default for new conversations. Keeping
    /// this on the adapter avoids provider ids and setting keys in shared
    /// session orchestration.
    fn access_mode_setting_key(&self) -> Option<Cow<'static, str>> {
        None
    }

    /// Whether a live runtime can apply an access-mode change without a
    /// respawn. Providers with a live policy hook (Codex's app server, Cursor's
    /// host-side Auto Review preflight) return true; providers whose whole
    /// access mode lives in process launch flags return false.
    fn applies_access_mode_in_place(&self) -> bool {
        false
    }

    /// Whether an access-mode change still requires respawning (for example
    /// when it changes launch flags). `from` is the last spawned mode.
    /// Defaults to true; in-place adapters may opt out.
    fn access_mode_change_needs_respawn(
        &self,
        _from: Option<&RuntimeAccessMode>,
        _to: &RuntimeAccessMode,
    ) -> bool {
        true
    }

    async fn configured_access_mode(
        &self,
        read_pool: &sqlx::SqlitePool,
    ) -> Option<RuntimeAccessMode> {
        let setting_key = self.access_mode_setting_key()?;
        Some(super::adapter_defaults::configured_access_mode(read_pool, setting_key.as_ref()).await)
    }

    /// Initial mode after `provider.set`; matches the frontend catalog fallback.
    fn default_permission_mode_wire(&self) -> Cow<'static, str> {
        Cow::Borrowed("acceptEdits")
    }

    /// Wire string selected after plan approval; `model` may refine the choice.
    fn post_plan_approval_mode_wire(&self, _model: Option<&str>) -> Cow<'static, str> {
        self.default_permission_mode_wire()
    }

    /// Fallback after the CLI rejects the post-plan mode. `None` propagates
    /// the error. Claude uses this when an advertised auto-capable alias
    /// proves unsupported at runtime.
    fn post_plan_approval_fallback_mode_wire(
        &self,
        _failed_mode_wire: &str,
    ) -> Option<Cow<'static, str>> {
        None
    }

    /// Mode to spawn with instead of the spawn config's when the runtime would
    /// silently ignore it for that model. `None` keeps the requested mode.
    async fn spawn_mode_fallback(&self, _: &RuntimeSpawnConfig) -> Option<RuntimePermissionMode> {
        None
    }

    async fn session_finished(&self, _runtime_session_id: &str) -> bool {
        false
    }

    /// If the runtime session has reached a terminal state, return the text
    /// of the latest assistant message. May be empty when the provider can't
    /// expose final text or the message contains only non-text parts. Return
    /// `None` if the session is still running.
    ///
    /// Default delegates to `session_finished` and returns no text — adapters
    /// whose drain loop can race ahead of streamed text (e.g. short turns)
    /// should override to return the actual text so callers can recover from
    /// a probe-wins-the-race exit.
    async fn session_finished_text(&self, runtime_session_id: &str) -> Option<String> {
        if self.session_finished(runtime_session_id).await {
            Some(String::new())
        } else {
            None
        }
    }

    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError>;
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::RwLock;

    use super::super::config::RuntimeSpawnConfig;
    use super::super::error::RuntimeError;
    use super::super::session::test_support::DummySession;
    use super::super::session::AgentRuntimeSession;
    use super::super::user_shell::RuntimeUserShellStrategy;
    use super::AgentRuntimeAdapter;

    struct DummyAdapter;

    #[async_trait]
    impl AgentRuntimeAdapter for DummyAdapter {
        fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
            crate::domain::agents::runtime::ProviderCatalogEntry {
                id: "dummy".to_string(),
                label: "Dummy".to_string(),
                icon_data: None,
                status: crate::domain::agents::runtime::ProviderStatus::Available,
                status_message: None,
                models: vec![],
                modes: vec![],
                access_modes: vec![],
                default_model: None,
            }
        }

        async fn spawn(
            &self,
            _content: serde_json::Value,
            _config: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            Ok(Box::new(DummySession))
        }
    }

    #[tokio::test]
    async fn adapter_defaults_are_provider_neutral() {
        let adapter = DummyAdapter;
        assert!(adapter.is_valid_resume_session_id("anything"));
        assert_eq!(
            adapter.persistable_resume_session_id(Some("anything")),
            Some("anything".to_string())
        );
        assert!(adapter
            .parse_permission_request(&json!({"type": "none"}))
            .is_none());
        assert!(!adapter.supports_prompt_receipts());
        assert!(!adapter.uses_legacy_permission_channel_on_response_error());
        assert_eq!(adapter.profile_name_for_new_session(), None);
        assert_eq!(adapter.environment_for_new_session(), None);
        assert_eq!(
            adapter.user_shell_strategy(),
            RuntimeUserShellStrategy::Unsupported
        );

        let spawned = adapter
            .spawn(serde_json::Value::Null, RuntimeSpawnConfig::default())
            .await
            .expect("spawn should succeed");
        let query = RwLock::new(spawned);
        assert_eq!(
            query.read().await.session_id().await.as_deref(),
            Some("dummy")
        );
    }

    struct FinishedAdapter;

    #[async_trait]
    impl AgentRuntimeAdapter for FinishedAdapter {
        fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
            DummyAdapter.catalog_entry()
        }

        async fn spawn(
            &self,
            _content: serde_json::Value,
            _config: RuntimeSpawnConfig,
        ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
            Ok(Box::new(DummySession))
        }

        async fn session_finished(&self, _runtime_session_id: &str) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn session_finished_text_default_returns_empty_when_finished() {
        // Default delegate: `Some("")` when finished (drain still exits via
        // the reconciler), `None` otherwise (drain keeps polling).
        assert_eq!(
            FinishedAdapter.session_finished_text("sid").await,
            Some(String::new())
        );
        assert_eq!(DummyAdapter.session_finished_text("sid").await, None);
    }
}
