pub(in crate::domain::agents) mod acp;
pub(in crate::domain::agents) mod agents;
pub(in crate::domain::agents::opencode) mod commands;
pub(crate) mod permissions;
mod questions;
mod stream_synthesizer;
mod tool_names;
mod worktree_config;
use async_trait::async_trait;
use serde_json::Value;

use self::permissions::{
    parse_permission_request as parse_acp_permission_request, permission_options,
};
use super::adapter::{
    AgentRuntimeAdapter, AgentRuntimeSession, RuntimeCompactionStrategy, RuntimeError,
    RuntimePermissionRequest, RuntimeSlashCommand, RuntimeSpawnConfig,
};

pub struct OpenCodeAdapter;

pub static OPENCODE_ADAPTER: OpenCodeAdapter = OpenCodeAdapter;
pub const PROVIDER_ID: &str = "opencode";

fn normalize_resume_session_id(session_id: &str) -> Option<String> {
    let trimmed = session_id.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[async_trait]
impl AgentRuntimeAdapter for OpenCodeAdapter {
    fn is_valid_resume_session_id(&self, session_id: &str) -> bool {
        normalize_resume_session_id(session_id).is_some()
    }

    fn resolve_resume_session_id(&self, runtime_session_id: Option<&str>) -> Option<String> {
        runtime_session_id.and_then(normalize_resume_session_id)
    }

    fn parse_permission_request(&self, raw: &Value) -> Option<RuntimePermissionRequest> {
        parse_acp_permission_request(raw).map(|request| RuntimePermissionRequest {
            request_id: request.request_id,
            tool_use_id: request.call_id,
            tool_name: request.tool_name,
            tool_input: request.tool_input,
            description: request.description,
            pattern: None,
            preview: request.preview,
            options: request.options.unwrap_or_else(permission_options),
        })
    }

    fn accepts_model(&self, model: &str) -> bool {
        crate::domain::agents::model_refs::is_opencode_model_ref(model)
    }

    fn catalog_entry(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
        super::providers::opencode::catalog_entry()
    }

    async fn catalog_entry_live(&self) -> crate::domain::agents::runtime::ProviderCatalogEntry {
        super::providers::opencode::catalog_entry_live().await
    }

    async fn catalog_entry_live_for_cwd(
        &self,
        cwd: Option<&std::path::Path>,
    ) -> crate::domain::agents::runtime::ProviderCatalogEntry {
        let mut entry = super::providers::opencode::catalog_entry_live().await;
        if let Some(cwd) = cwd {
            entry.modes = agents::primary_agent_modes(cwd).await;
        }
        entry
    }

    async fn context_window_for_model(&self, model_id: &str) -> Option<u64> {
        super::providers::opencode::context_window_for_model(model_id).await
    }

    fn supports_thinking_effort_level(&self, model_id: &str, effort: &str) -> Option<bool> {
        Some(super::providers::opencode::supports_effort_level_for_model_ref(model_id, effort))
    }

    fn supports_prompt_receipts(&self) -> bool {
        true
    }

    async fn default_model_id(&self) -> Option<String> {
        super::providers::opencode::default_model_id().await
    }

    fn spawn_startup_warmup(&self) {
        // Warm the live catalog cache off the request path. The probe
        // runs a short-lived `opencode models --verbose`; running it at
        // startup means the first FE provider-picker render hits a
        // populated cache instead of waiting on a fresh probe.
        tokio::spawn(async {
            let _ = super::providers::opencode::catalog_entry_live().await;
        });
    }

    fn worktree_config_paths(&self) -> &'static [&'static str] {
        worktree_config::CONFIG_PATHS
    }

    async fn runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        // ACP-first: `opencode acp` pushes its slash-command catalog
        // (built-ins + project-local) over `available_commands_update`.
        // The runtime mirrors each push into `commands::record_snapshot`
        // via `OpenCodeAcpAdapter::record_available_commands`. Here we
        // read the latest snapshot for `cwd` — the synchronous fast
        // path. A fresh probe is triggered separately by the WS
        // handler via `refresh_runtime_slash_commands` so the FE gets
        // instant cached feedback plus a live update when the probe
        // finishes.
        commands::runtime_slash_commands(cwd).await
    }

    fn supports_runtime_slash_command_refresh(&self) -> bool {
        true
    }

    async fn refresh_runtime_slash_commands(
        &self,
        cwd: &str,
    ) -> Result<Vec<RuntimeSlashCommand>, RuntimeError> {
        // Spawn an ephemeral `opencode acp` probe, run the handshake,
        // wait for the first `available_commands_update` push, snapshot
        // it, and reap. Single-flighted per cwd so concurrent `/`
        // triggers share one probe.
        commands::refresh_via_acp(cwd).await
    }

    fn compaction_strategy(&self) -> Option<RuntimeCompactionStrategy> {
        // ACP subprocess is session-scoped and there's no spec'd way to
        // replay a summary back into it, so SummaryReplay would silently
        // lose context. Use LiveRuntime, which relies on the agent's own
        // context-window tracking (surfaced via the `usage_update`
        // notification → `RuntimeEventMetadata.context_window`).
        Some(RuntimeCompactionStrategy::LiveRuntime)
    }

    fn supports_permission_mode(
        &self,
        mode: &crate::domain::agents::adapter::RuntimePermissionMode,
    ) -> bool {
        // OpenCode primary agents are `build` (default/acceptEdits) and `plan`.
        // Auto / Bypass / DontAsk have no equivalent.
        use crate::domain::agents::adapter::RuntimePermissionMode;
        matches!(
            mode,
            RuntimePermissionMode::Default
                | RuntimePermissionMode::AcceptEdits
                | RuntimePermissionMode::Plan
                | RuntimePermissionMode::OpenCodeAgent(_)
        )
    }
    // Default `default_permission_mode_wire` ("acceptEdits") maps to OpenCode's
    // `build` agent in the adapter — see `permission_mode_agent` in model.rs.

    async fn session_finished(&self, runtime_session_id: &str) -> bool {
        // ACP signals subprocess exit through `AcpEvent::ProcessExited` on
        // the runtime channel; the session-finished probe always answers
        // "no" since a finished agent turn isn't the same as a finished
        // session (the subprocess stays alive across turns).
        acp::session_finished(runtime_session_id).await
    }

    async fn spawn(
        &self,
        content: Value,
        config: RuntimeSpawnConfig,
    ) -> Result<Box<dyn AgentRuntimeSession>, RuntimeError> {
        acp::spawn_acp_session(content, config).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::OpenCodeAdapter;
    use crate::domain::agents::adapter::AgentRuntimeAdapter;

    #[test]
    fn acp_reuses_non_empty_resume_session_ids() {
        let adapter = OpenCodeAdapter;
        assert!(adapter.is_valid_resume_session_id("ses_stale"));
        assert!(adapter.supports_prompt_receipts());
        assert_eq!(
            adapter.resolve_resume_session_id(Some("  ses_stale  ")),
            Some("ses_stale".to_string())
        );
        assert_eq!(adapter.resolve_resume_session_id(Some("   ")), None);
    }

    #[test]
    fn adapter_parses_acp_permission_request() {
        let adapter = OpenCodeAdapter;
        let parsed = adapter
            .parse_permission_request(&json!({
                "type": "acp_permission_request",
                "request_id": "req-1",
                "tool_name": "Read",
                "tool_input": { "filePath": "README.md" },
                "description": "Read file"
            }))
            .expect("expected permission request");

        assert_eq!(parsed.request_id, "req-1");
        assert_eq!(parsed.tool_name, "Read");
        assert_eq!(parsed.tool_input, json!({ "filePath": "README.md" }));
        assert_eq!(parsed.description.as_deref(), Some("Read file"));
        assert_eq!(parsed.pattern, None);
        assert_eq!(parsed.preview.as_deref(), Some("README.md"));
        assert_eq!(parsed.options.len(), 3);
    }

    #[test]
    fn adapter_ignores_non_permission_events() {
        let adapter = OpenCodeAdapter;
        assert!(adapter
            .parse_permission_request(&json!({ "type": "other_event" }))
            .is_none());
    }
}
