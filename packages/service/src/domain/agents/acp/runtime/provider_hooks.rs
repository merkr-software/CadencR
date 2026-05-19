//! Provider-specific extension points for the ACP runtime.
//!
//! Concrete adapters implement this trait to plug provider-specific
//! normalization and policy decisions into the otherwise provider-neutral
//! runtime.

use std::path::Path;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::domain::agents::adapter::{
    RuntimeError, RuntimeEvent, RuntimeEventMetadata, RuntimePermissionMode,
    RuntimePermissionResponse, RuntimeSlashCommand, RuntimeUsage,
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

#[cfg(test)]
struct DefaultFlattenHooks;

#[cfg(test)]
#[async_trait]
impl AcpProviderHooks for DefaultFlattenHooks {
    fn normalize_tool_name(&self, raw: &str) -> String {
        raw.to_string()
    }
    fn normalize_tool_input(&self, _tool_name: &str, input: Value) -> Value {
        input
    }
    fn mode_for_permission_mode(&self, _mode: RuntimePermissionMode) -> Option<String> {
        None
    }
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
    fn model_config_id(&self) -> Option<&'static str> {
        None
    }

    /// Provider config id for thinking-effort changes over `session/set_config_option`.
    fn thinking_effort_config_id(&self) -> Option<&'static str> {
        None
    }

    /// Fallback provider mode id when a session response omits `currentModeId`.
    fn default_mode_id(&self) -> Option<&'static str> {
        None
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

    /// Whether a provider's ACP sessions can be durably restored across a
    /// newly spawned subprocess via `session/load`.
    fn supports_durable_resume(&self) -> bool {
        false
    }

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

#[cfg(test)]
mod tests {
    use super::{AcpProviderHooks, DefaultFlattenHooks};
    use serde_json::{json, Value};

    #[test]
    fn default_flatten_tool_result_content_joins_text_blocks() {
        let hooks = DefaultFlattenHooks;
        let payload = hooks.flatten_tool_result_content(&[
            json!({ "type": "text", "text": "first" }),
            json!({ "type": "text", "text": "second" }),
        ]);
        assert_eq!(payload, Value::String("first\nsecond".to_string()));
    }

    #[test]
    fn default_flatten_tool_result_content_preserves_structured_blocks() {
        let hooks = DefaultFlattenHooks;
        let blocks = vec![json!({ "type": "diff", "path": "a.rs" })];
        assert_eq!(hooks.flatten_tool_result_content(&blocks), json!(blocks));
    }
}
