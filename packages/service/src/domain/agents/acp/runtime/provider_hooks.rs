//! Provider-specific extension points for the ACP runtime.

use std::path::Path;

use agent_client_protocol::schema::v1::SessionConfigOption;
use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::domain::agents::acp::AcpClient;
use crate::domain::agents::adapter::{
    RuntimeAccessMode, RuntimeError, RuntimeEvent, RuntimeEventMetadata, RuntimeMcpServerStatus,
    RuntimePermissionDecision, RuntimePermissionMode, RuntimePermissionRequest,
    RuntimePermissionResponse, RuntimePermissionResponseKind, RuntimeSessionConfigSnapshot,
    RuntimeSessionConfigValue, RuntimeSlashCommand, RuntimeUsage,
};

use super::events_stream_blocks::EventIndexer;

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

/// Provider-normalized blocking extension request, transported through the
/// same permission bridge as canonical ACP permission requests.
pub struct AcpExtensionRequest {
    pub permission: RuntimePermissionRequest,
    pub events: Vec<RuntimeEvent>,
}

/// Adapter-owned result for a pending ACP server request. Most requests only
/// need a response payload; providers whose protocol requires a new prompt
/// after the current turn may also queue a follow-up here.
pub struct AcpServerRequestResolution {
    pub response: Value,
    pub followup: Option<Value>,
}

#[async_trait]
pub trait AcpProviderHooks: Send + Sync {
    /// Provider-specific authentication immediately after `initialize` and
    /// before `session/new`/`session/load`. Pre-authenticated agents use the
    /// no-op default.
    async fn authenticate(
        &self,
        _client: &AcpClient,
        _initialize_response: &Value,
    ) -> Result<(), RuntimeError> {
        Ok(())
    }

    /// Map a raw ACP `toolName` (often lowercase or aliased) onto the
    /// canonical Cadencr Pascal-case tool name.
    fn normalize_tool_name(&self, raw: &str) -> String;

    /// Massage the tool input JSON for a known tool (e.g. rewriting OpenCode's
    /// `oldText`/`newText` into `old_string`/`new_string`).
    fn normalize_tool_input(&self, tool_name: &str, input: Value) -> Value;

    /// Recover provider-specific permission input that ACP omitted from
    /// `rawInput`. Defaults to the input parsed from the standard request.
    fn derive_permission_tool_input(
        &self,
        _tool_name: &str,
        input: Value,
        _params: &Value,
    ) -> Value {
        input
    }

    /// Reduce ACP `ToolCallContent[]` to a shape the FE renders directly.
    /// Most providers can rely on the default flatten that joins text blocks;
    /// some (OpenCode) wrap text in a `{type: "content"}` envelope and need
    /// to unwrap before flattening.
    fn flatten_tool_result_content(&self, blocks: &[Value]) -> Value {
        flatten_tool_result_content_with(blocks, unwrap_text_block)
    }

    /// Map a Cadencr permission mode onto the provider's mode id.
    fn mode_for_permission_mode(&self, mode: RuntimePermissionMode) -> Option<String>;

    /// Extra `_meta` on initialize `clientCapabilities` (Cursor: parameterizedModelPicker).
    fn client_capabilities_meta(&self) -> agent_client_protocol::schema::v1::Meta {
        agent_client_protocol::schema::v1::Meta::new()
    }

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

    /// Translate Cadencr catalog model id into the provider's live ACP wire value.
    fn model_config_value(&self, model: &str) -> String {
        model.to_string()
    }

    /// Extra set_config_option pairs after the model response (Cursor fast / thought-level).
    fn model_config_companions(&self, _model: &str) -> Vec<(String, RuntimeSessionConfigValue)> {
        Vec::new()
    }

    /// Project a model config value into the legacy catalog-model domain.
    /// Providers with parameterized model IDs return `None` until they can
    /// reconstruct the complete catalog selection from the snapshot.
    fn legacy_model_from_session_config(
        &self,
        model_value: &str,
        _snapshot: &RuntimeSessionConfigSnapshot,
    ) -> Option<String> {
        Some(model_value.to_string())
    }

    /// Catalog model already encodes effort applied via companions; skip spawn effort RPC.
    fn model_encodes_thinking_effort(&self, _model: &str) -> bool {
        false
    }

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
    fn compact_prompt(&self) -> Option<&'static str> {
        None
    }

    /// Provider-specific fallback for prompt-response usage. Generic ACP
    /// ignores `session/prompt` usage because the protocol shape is per-turn;
    /// providers may opt in when their response carries context occupancy.
    fn prompt_response_usage(&self, _response: &Value) -> Option<RuntimeUsage> {
        None
    }

    /// Normalize a blocking provider extension into Cadencr's permission
    /// bridge. Returning `None` makes the runtime reject the method as unknown.
    fn extension_request(
        &self,
        _request_id: &str,
        _method: &str,
        _params: &Value,
        _metadata: RuntimeEventMetadata,
    ) -> Option<AcpExtensionRequest> {
        None
    }

    /// Map a fire-and-forget provider extension to provider-neutral events.
    fn extension_notification(
        &self,
        _method: &str,
        _params: &Value,
        _metadata: RuntimeEventMetadata,
    ) -> Option<Vec<RuntimeEvent>> {
        None
    }

    /// Encode the user's response to a pending server request. Canonical ACP
    /// permission requests use the default payload; provider extensions may
    /// translate to their own response schema inside the adapter.
    fn resolve_server_request(
        &self,
        _method: &str,
        _params: &Value,
        response: &RuntimePermissionResponse,
    ) -> AcpServerRequestResolution {
        AcpServerRequestResolution {
            response: super::permissions::acp_permission_response_payload(
                response.decision,
                response.option_id.as_deref(),
                response.feedback.as_deref(),
            ),
            followup: None,
        }
    }

    /// Provider-scoped preflight for canonical ACP permission requests.
    /// Returning a decision answers the agent immediately without surfacing a
    /// user prompt. The runtime only applies it when the matching option was
    /// explicitly offered by the provider.
    fn automatic_permission_decision(
        &self,
        _request: &RuntimePermissionRequest,
        _params: &Value,
    ) -> Option<RuntimePermissionDecision> {
        None
    }

    /// Classify special blocking requests for shared post-response behavior.
    fn permission_response_kind(&self, _request_id: &str) -> RuntimePermissionResponseKind {
        RuntimePermissionResponseKind::Normal
    }

    /// Apply an access/autonomy change to the live session's in-memory state.
    ///
    /// Providers whose access mode drives a *host-side* permission decision
    /// (Cursor's Auto Review preflights allowlist misses inside
    /// [`automatic_permission_decision`]) update their stored mode here so the
    /// change takes effect on the current turn without respawning. The default
    /// is a no-op for providers whose access mode is encoded purely in process
    /// launch flags — those rely on the runtime respawn path instead.
    fn update_access_mode(&self, _mode: RuntimeAccessMode) {}

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

    /// Provider opt-in: append extra events to a completed `tool_call_update`.
    /// Returns events the runtime splices into the mapped update's event list
    /// — used by OpenCode to emit a synthetic `AssistantMessage` carrying the
    /// sub-agent's final text under `parent_tool_use_id`. Each returned event
    /// must already carry its own `parent_tool_use_id`; the runtime does not
    /// stamp on top of these.
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

pub(crate) fn flatten_tool_result_content_with<'a>(
    blocks: &'a [Value],
    unwrap_text: impl Fn(&'a Value) -> Option<&'a str>,
) -> Value {
    if blocks.is_empty() {
        return serde_json::json!(blocks);
    }
    let mut texts = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Some(text) = unwrap_text(block) else {
            return serde_json::json!(blocks);
        };
        texts.push(text);
    }
    Value::String(texts.join("\n"))
}

fn unwrap_text_block(block: &Value) -> Option<&str> {
    let kind = block.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => block.get("text").and_then(Value::as_str),
        _ => None,
    }
}
