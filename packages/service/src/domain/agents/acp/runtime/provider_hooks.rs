//! Provider-specific extension points for the ACP runtime.

use std::path::Path;

use agent_client_protocol::schema::v1::SessionConfigOption;
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeEventMetadata, RuntimeMcpServerStatus,
    RuntimePermissionMode, RuntimePermissionResponse, RuntimeSlashCommand, RuntimeUsage,
};
use crate::domain::agents::runtime::ProviderPromptCapabilities;

use super::events_stream_blocks::EventIndexer;
use super::tool_result_flatten::unwrap_text_block;
pub(crate) use super::tool_result_flatten::{
    flatten_tool_result_content_with, unwrap_nested_text_block,
};

/// Outcome of a provider-side fallback permission response. See the doc on
/// `AcpProviderHooks::respond_permission_fallback`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionFallbackOutcome {
    /// Provider does not recognise this request id; runtime should error.
    NotHandled,
    /// Provider handled the response. No session-scope caching needed
    /// (one-shot tools like AskUserQuestion).
    Handled,
    /// Provider handled the response. Runtime should record the decision
    /// in the session-scope permission cache under `(tool_name, tool_input)`
    /// so identical follow-up calls don't re-prompt.
    HandledWithCacheKey {
        tool_name: String,
        tool_input: Value,
    },
}

#[async_trait]
pub trait AcpProviderHooks: Send + Sync {
    /// Map a raw ACP `toolName` (often lowercase or aliased) onto the
    /// canonical Cadencr Pascal-case tool name.
    fn normalize_tool_name(&self, raw: &str) -> String;

    /// Massage the tool input JSON for a known tool (e.g. rewriting OpenCode's
    /// `oldText`/`newText` into `old_string`/`new_string`).
    fn normalize_tool_input(&self, tool_name: &str, input: Value) -> Value;

    /// Reduce ACP `ToolCallContent[]` to a shape the FE renders directly.
    /// Most providers can rely on the default flatten that joins text blocks;
    /// some (OpenCode) wrap text in a `{type: "content"}` envelope and need
    /// to unwrap before flattening.
    fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
        flatten_tool_result_content_with(blocks, unwrap_text_block)
    }

    /// Map a Cadencr permission mode onto the provider's mode id.
    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String>;

    /// Provider config id for model changes over `session/set_config_option`.
    fn model_config_id(&self) -> Option<&str> {
        None
    }

    /// Require a preselected catalog model to exist in live ACP configuration
    /// and be confirmed before the first prompt. Built-ins retain their legacy
    /// fallbacks; code-backed installed providers opt into the strict contract.
    fn requires_verified_model_selection(&self) -> bool {
        false
    }

    /// Observe live session config options (retain aliases for later set_config_option).
    fn observe_session_config_options(&self, _options: &[SessionConfigOption]) {}

    /// Provider config id for thinking-effort over `session/set_config_option`.
    fn thinking_effort_config_id(&self) -> Option<String> {
        None
    }

    /// Fallback provider mode id when a session response omits `currentModeId`.
    fn default_mode_id(&self) -> Option<&'static str> {
        None
    }

    /// Provider-native user shell dispatch for ACP-backed runtimes. Generic
    /// ACP has no such method; adapters that advertise native support must
    /// bridge to a provider-specific side channel here.
    async fn run_user_shell_command(
        &self,
        _session_id: &str,
        _agent: &str,
        _command: &str,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "provider-native user shell commands are not supported by these ACP hooks",
        ))
    }

    /// Prompt text used for manual compaction, when the provider supports it.
    fn compact_prompt(&self) -> Option<String> {
        None
    }

    /// Id of the live mode-category config option, when the session exposes
    /// one: mode changes then go through `session/set_config_option` instead
    /// of `session/set_mode`.
    fn mode_config_id(&self) -> Option<String> {
        None
    }

    /// Inverse of [`Self::mode_for_permission_mode`], so agent-initiated mode
    /// switches can be reported in host terms. `None` leaves them local.
    fn permission_mode_for_mode_id(&self, _mode_id: &str) -> Option<RuntimePermissionMode> {
        None
    }

    /// `(config id, value)` that applies a host access mode through
    /// `session/set_config_option`; `None` when the provider maps none.
    fn access_mode_config(&self, _mode: &RuntimeAccessMode) -> Option<(String, String)> {
        None
    }

    /// Observe the `initialize` response's `promptCapabilities`.
    fn observe_prompt_capabilities(&self, _capabilities: ProviderPromptCapabilities) {}

    /// Refuse prompt blocks the agent cannot accept before they are sent, so
    /// an unsupported attachment fails visibly instead of being dropped.
    fn validate_prompt_blocks(&self, _blocks: &[Value]) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// Provider-specific fallback for prompt-response usage. Generic ACP
    /// ignores `session/prompt` usage because the protocol shape is per-turn;
    /// providers may opt in when their response carries context occupancy.
    fn prompt_response_usage(&self, _response: &Value) -> Option<RuntimeUsage> {
        None
    }

    /// Provider opt-in: refine the MCP server statuses negotiated at
    /// spawn. Generic ACP only knows the configured catalog, so providers
    /// with their own status mechanism can replace it here.
    async fn available_mcp_servers(
        &self,
        _cwd: &Path,
        configured: Vec<RuntimeMcpServerStatus>,
    ) -> Vec<RuntimeMcpServerStatus> {
        configured
    }

    /// Whether a provider's ACP sessions can be durably restored across a
    /// newly spawned subprocess via `session/resume` or legacy `session/load`.
    fn supports_durable_resume(&self) -> bool {
        false
    }

    /// Observe handshake-owned ACP durable-resume support. Installed provider
    /// adapters use this to avoid persisting unusable IDs while still allowing
    /// a stored ID to be probed after the host process restarts.
    fn observe_durable_resume_capability(&self, _supported: bool) {}

    /// Provider-specific hook for `AskUserQuestion`-style tool calls. Returns
    /// `Some(event)` to short-circuit the normal `tool_call` start mapping.
    fn tool_call_start_override(
        &self,
        _tool_call_id: &str,
        _tool_name: &str,
        _tool_input: &Value,
        _metadata: &RuntimeEventMetadata,
        _parent_tool_use_id: Option<&str>,
        _indexer: &mut EventIndexer,
    ) -> Option<RuntimeEvent> {
        None
    }

    /// Provider-specific hook for `tool_call_update` payloads. Returns
    /// `Some(event)` to short-circuit normal update handling — used by
    /// providers (OpenCode) where the question payload only arrives in the
    /// update, never in the original start.
    fn tool_call_update_override(
        &self,
        _tool_call_id: &str,
        _body: &Value,
        _status: &str,
        _metadata: &RuntimeEventMetadata,
        _parent_tool_use_id: Option<&str>,
        _indexer: &mut EventIndexer,
    ) -> Option<RuntimeEvent> {
        None
    }

    /// Last-resort hook for permission responses that don't match a pending
    /// ACP server request. OpenCode uses this to forward question-tool
    /// answers to its sidecar HTTP endpoint *and* to answer permission
    /// requests sourced from its `/event` SSE bus (which never reach the
    /// ACP wire). The variant returned drives the runtime's session-scope
    /// cache:
    /// - `NotHandled`: not ours; runtime surfaces a no-pending error.
    /// - `Handled`: handled, no caching needed (one-shot, e.g. question tool).
    /// - `HandledWithCacheKey`: handled and the runtime should record the
    ///   decision under `(tool_name, tool_input)` so a follow-up call
    ///   with the same shape can skip the prompt.
    async fn respond_permission_fallback(
        &self,
        _response: RuntimePermissionResponse,
    ) -> Result<PermissionFallbackOutcome, RuntimeError> {
        Ok(PermissionFallbackOutcome::NotHandled)
    }

    /// Provider opt-in: suppress the default `rawOutput` tool_result emission
    /// for `tool_name`. OpenCode uses this to drop the noisy
    /// `{metadata, output}` JSON dump for sub-agent tools (`Task` / `Agent`),
    /// since the cleaned body text is synthesised separately under the parent
    /// block via `synthesize_tool_call_completion`.
    fn suppresses_raw_output(&self, _tool_name: &str) -> bool {
        false
    }

    /// Provider opt-in: append extra events to a terminal (`completed` /
    /// `failed`) `tool_call_update` — OpenCode emits a synthetic
    /// `AssistantMessage` with the sub-agent's final text under
    /// `parent_tool_use_id`. Each event must carry its own
    /// `parent_tool_use_id`; the runtime does not stamp on top of these.
    /// Sub-agent signal events (`RuntimeEvent::subagent_signal`) are folded
    /// into the call's terminal event after the generic carrier patch, so a
    /// provider's status/metadata wins (see `events_tool_call_subagent`).
    fn synthesize_tool_call_completion(
        &self,
        _tool_call_id: &str,
        _tool_name: &str,
        _body: &Value,
        _status: &str,
        _metadata: &RuntimeEventMetadata,
        _indexer: &mut EventIndexer,
    ) -> Vec<RuntimeEvent> {
        Vec::new()
    }

    /// Provider opt-in: spawn a side-channel that pushes additional
    /// `RuntimeEvent`s onto the same runtime channel. Used by OpenCode to
    /// subscribe to the underlying HTTP polling channel for live sub-agent
    /// child-session events (which OpenCode's ACP transport silently drops
    /// today because its session manager only forwards events for sessions
    /// it has explicitly registered).
    ///
    /// Implementors return an optional `JoinHandle`; the runtime aborts it on
    /// `close()` so the listener stops cleanly. Default implementation does
    /// nothing.
    fn start_side_channel(
        &self,
        _session_id: &str,
        _cwd: &Path,
        _context_window: Option<u64>,
        _tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
    ) -> Option<JoinHandle<()>> {
        None
    }

    /// Provider opt-in: invoked at the start of every `tool_call` (after the
    /// canonical name has been resolved) so adapters can record state for
    /// later use by their side-channel — e.g. OpenCode tracks pending
    /// `Task`/`Agent` call ids so its polling listener can pair freshly-spawned
    /// child sessions with the right parent tool block.
    ///
    /// Default implementation is a no-op. This is intentionally separate from
    /// `tool_call_start_override` (which decides whether to short-circuit
    /// event emission); both fire on the same notification.
    fn record_tool_call_start(&self, _tool_call_id: &str, _tool_name: &str) {}

    /// Provider opt-in: observe every `tool_call_update` after the canonical
    /// tool name is known. OpenCode uses this to bind a Task's
    /// `task_id` / `metadata.sessionId` onto the pending child-session queue
    /// so HTTP pairing does not rely on FIFO alone.
    fn observe_tool_call_update(&self, _tool_call_id: &str, _tool_name: &str, _body: &Value) {}

    /// Provider opt-in: persist the latest slash-command catalog the
    /// agent pushed via ACP `available_commands_update`, scoped to the
    /// session's `cwd`. The synchronous WS `commands.get` request the
    /// FE makes before/between turns reads this back through the
    /// adapter's `runtime_slash_commands(cwd)`, so the picker reflects
    /// what the live ACP session actually advertises (built-ins +
    /// project-local) instead of duplicating discovery via HTTP.
    ///
    /// Default implementation is a no-op so non-opencode ACP providers
    /// don't have to opt in.
    async fn record_available_commands(&self, _cwd: &Path, _commands: Vec<RuntimeSlashCommand>) {}
}
