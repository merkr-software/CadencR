use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;

use super::config::{RuntimePermissionMode, RuntimeSpawnConfig};
use super::error::RuntimeError;
use super::event_types::RuntimeEvent;
use super::permission::{RuntimeCompactionStrategy, RuntimePermissionRequest, RuntimeSlashCommand};
use super::session::AgentRuntimeSession;

#[async_trait]
pub trait AgentRuntimeAdapter: Send + Sync {
    fn is_valid_resume_session_id(&self, _session_id: &str) -> bool {
        true
    }

    fn parse_permission_request(&self, _raw: &Value) -> Option<RuntimePermissionRequest> {
        None
    }

    /// Returns true if this adapter should handle the given model string.
    /// Used for automatic provider routing when the user selects a model.
    fn accepts_model(&self, _model: &str) -> bool {
        false
    }

    /// Resolve a resume session ID from the DB-stored runtime_session_id.
    /// The default accepts any string. Override to apply validation (e.g. UUID-only).
    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id.map(ToOwned::to_owned)
    }

    /// Static catalog entry (available immediately at startup).
    fn catalog_entry(&self) -> super::super::runtime::ProviderCatalogEntry;

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

    /// Live catalog entry with access to persisted settings. Providers whose
    /// discovery depends on app settings (for example Claude Code profiles
    /// that inject Bedrock/Vertex env vars) can override this request-aware
    /// hook while other providers keep the cwd-only default.
    async fn catalog_entry_live_for_settings(
        &self,
        _read_pool: &sqlx::SqlitePool,
        cwd: Option<&Path>,
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
    ///
    /// Mirrors [`catalog_entry_live_for_settings`]: providers whose default
    /// depends on app settings (Claude Code profiles injecting Bedrock/Vertex
    /// env) must resolve the default against the *same* probe env the catalog
    /// uses, otherwise the default-model probe runs with a different env key
    /// and thrashes the shared catalog cache. Defaults to the settings-agnostic
    /// [`default_model_id`].
    async fn default_model_id_for_settings(&self, _read_pool: &sqlx::SqlitePool) -> Option<String> {
        self.default_model_id().await
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

    fn worktree_config_paths(&self) -> &'static [&'static str] {
        &[]
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
        let label = self.catalog_entry().label;
        crate::domain::agents::config_migration::copy_provider_config_paths(
            &label,
            source_project_path,
            worktree_path,
            paths,
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

    /// Whether `refresh_runtime_slash_commands` performs a real
    /// re-resolve (vs. a no-op default). The WS `commands.get` handler
    /// reads this to decide whether to advertise `refreshing: true`
    /// and spawn a background refresh task. Default `false` — providers
    /// that can re-resolve (today: OpenCode via an ephemeral ACP probe)
    /// override.
    fn supports_runtime_slash_command_refresh(&self) -> bool {
        false
    }

    /// Force a fresh re-resolve of the slash-command catalog (typically
    /// by spawning a short-lived discovery probe). Used by the WS
    /// `commands.get` handler to background-refresh the cached snapshot
    /// every time the FE opens the `/` menu, so the picker stays in
    /// sync with on-disk command changes without the user having to
    /// reload the session.
    ///
    /// Default implementation is a no-op error so providers that don't
    /// opt in don't pay the cost of `runtime_slash_commands` (which
    /// for some adapters spawns a subprocess).
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

    /// Whether this provider's CLI can run a given permission mode. Used by
    /// the WS handler to reject `mode.set` requests the active provider
    /// doesn't support. Mirrored on the frontend by `lib/provider-modes.ts`.
    ///
    /// Default conservatively rejects every mode — adapters must opt in
    /// explicitly so a new provider doesn't silently accept Claude-flavored
    /// modes its CLI can't actually execute.
    fn supports_permission_mode(&self, _mode: &RuntimePermissionMode) -> bool {
        false
    }

    /// Wire string the chip lands on for this provider after a session
    /// switches to it (post-`provider.set`). Mirrors `defaultEditModeFor` in
    /// `lib/provider-modes.ts`. Default matches the FE catalog's fallback.
    fn default_permission_mode_wire(&self) -> &'static str {
        "acceptEdits"
    }

    /// Wire string the chip should land on after a plan is approved
    /// (post-`ExitPlanMode`). Mirrors `postPlanApprovalModeFor` in
    /// `lib/provider-modes.ts`. The `model` hint lets adapters pick a
    /// classifier-backed mode only when the active model can actually run
    /// it. Defaults to `default_permission_mode_wire` so adapters opt in
    /// explicitly to a plan-approval-specific override.
    fn post_plan_approval_mode_wire(&self, _model: Option<&str>) -> &'static str {
        self.default_permission_mode_wire()
    }

    /// If the post-plan target mode (chosen by
    /// `post_plan_approval_mode_wire`) is rejected by the live CLI,
    /// return a fallback wire string the orchestrator should retry with.
    /// Returning `None` means propagate the error.
    ///
    /// The motivating case is Claude Code's `auto` mode: the catalog
    /// advertises auto-capable aliases optimistically (we can't always
    /// tell from the CLI metadata alone whether a given resolved model
    /// actually supports it), so we observe the rejection at runtime and
    /// fall back to `acceptEdits`. Other providers default to `None`.
    fn post_plan_approval_fallback_mode_wire(
        &self,
        _failed_mode_wire: &str,
    ) -> Option<&'static str> {
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
    use super::AgentRuntimeAdapter;

    struct DummyAdapter;

    #[async_trait]
    impl AgentRuntimeAdapter for DummyAdapter {
        fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
            crate::domain::agents::runtime::ProviderCatalogEntry {
                id: "dummy".to_string(),
                label: "Dummy".to_string(),
                status: crate::domain::agents::runtime::ProviderStatus::Available,
                status_message: None,
                models: vec![],
                modes: vec![],
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
        assert!(adapter
            .parse_permission_request(&json!({"type": "none"}))
            .is_none());
        assert!(!adapter.supports_prompt_receipts());

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
