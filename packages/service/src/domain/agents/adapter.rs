use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, RwLock};

#[derive(Debug, Clone)]
pub struct RuntimeUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl RuntimeUsage {
    pub fn is_zero(&self) -> bool {
        self.input_tokens == 0 && self.output_tokens == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimePermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    /// Claude Code v2.1.83+ classifier-backed mode. Currently a Claude-only
    /// mode; OpenCode and Codex adapters fall back to their own "everyday"
    /// permission level when this is selected.
    Auto,
    DontAsk,
    OpenCodeAgent(String),
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum RuntimeMcpServerConfig {
    Stdio {
        command: String,
        args: Option<Vec<String>>,
        env: Option<HashMap<String, String>>,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeMcpServerStatus {
    pub name: String,
    pub status: String,
}

pub struct RuntimeSpawnConfig {
    pub cwd: PathBuf,
    pub permission_mode: Option<RuntimePermissionMode>,
    pub model: Option<String>,
    pub thinking_effort: Option<String>,
    pub system_prompt: Option<String>,
    pub resume_session_id: Option<String>,
    pub mcp_servers: Option<HashMap<String, RuntimeMcpServerConfig>>,
    pub permission_handler: Option<Arc<dyn RuntimeToolPermissionHandler>>,
    /// Extra env vars injected into the spawned runtime. Adapters decide how
    /// to apply this (Claude Code merges it into the CLI subprocess env;
    /// ACP-backed providers may ignore it when configuration is handled elsewhere).
    pub env: Option<HashMap<String, String>>,
}

impl Default for RuntimeSpawnConfig {
    fn default() -> Self {
        Self {
            cwd: PathBuf::new(),
            permission_mode: None,
            model: None,
            thinking_effort: None,
            system_prompt: None,
            resume_session_id: None,
            mcp_servers: None,
            permission_handler: None,
            env: None,
        }
    }
}

#[derive(Debug)]
pub enum RuntimeError {
    /// Generic runtime failure with a free-form message.
    Generic(String),
    /// The provider's CLI binary could not be located on disk. Carries the
    /// directories that were probed so the host can render an actionable
    /// message and prompt the user to set an explicit path via onboarding.
    CliNotFound {
        provider: &'static str,
        searched: Vec<PathBuf>,
    },
    /// The provider's CLI accepted the protocol envelope but rejected the
    /// requested operation (e.g. `set_permission_mode("auto")` on a model
    /// that doesn't support auto). `subtype` is the control-request
    /// subtype the SDK sent — callers (e.g. the post-plan-approval
    /// transition) can branch on this to apply a fallback. `message` is
    /// the CLI's verbatim error text.
    ControlRequestRejected { subtype: String, message: String },
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Generic(message) => f.write_str(message),
            Self::CliNotFound { provider, searched } => {
                write!(
                    f,
                    "{provider} CLI not found; searched {} location(s)",
                    searched.len()
                )
            }
            Self::ControlRequestRejected { subtype, message } => {
                write!(f, "CLI rejected control request `{subtype}`: {message}")
            }
        }
    }
}

impl std::error::Error for RuntimeError {}

impl RuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Generic(message.into())
    }

    /// Build a structured "CLI not found" error so the host can surface an
    /// actionable message + a link to the binary picker in onboarding.
    pub fn cli_not_found(provider: &'static str, searched: Vec<PathBuf>) -> Self {
        Self::CliNotFound { provider, searched }
    }
}

impl From<claude_agent_sdk_rs::SdkError> for RuntimeError {
    fn from(value: claude_agent_sdk_rs::SdkError) -> Self {
        match value {
            claude_agent_sdk_rs::SdkError::CliNotFound { searched } => {
                Self::cli_not_found("claude", searched)
            }
            // Preserve the structured rejection so adapters can apply
            // command-specific fallbacks (e.g. post-plan `auto` →
            // `acceptEdits`). Without this, the variant flattens to a
            // string and the only way to recover would be substring
            // matching on the message.
            claude_agent_sdk_rs::SdkError::ControlRequestFailed { subtype, message } => {
                Self::ControlRequestRejected { subtype, message }
            }
            other => Self::Generic(other.to_string()),
        }
    }
}

impl From<opencode_sdk_rs::SdkError> for RuntimeError {
    fn from(value: opencode_sdk_rs::SdkError) -> Self {
        match value {
            opencode_sdk_rs::SdkError::CliNotFound { searched } => {
                Self::cli_not_found("opencode", searched)
            }
            other => Self::Generic(other.to_string()),
        }
    }
}

impl From<codex_app_server_sdk_rs::SdkError> for RuntimeError {
    fn from(value: codex_app_server_sdk_rs::SdkError) -> Self {
        match value {
            codex_app_server_sdk_rs::SdkError::CliNotFound { searched } => {
                Self::cli_not_found("codex", searched)
            }
            other => Self::Generic(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePermissionDecision {
    AllowOnce,
    /// Persist the decision across sessions/runs. Maps to ACP's
    /// `allow_always` option kind. OpenCode ACP session permission caching persists this
    /// via an always-allow decision; ACP-side, the agent owns persistence
    /// via the `optionId` we echo back.
    AllowFuture,
    /// Allow for the lifetime of the current session only. Maps to ACP's
    /// `allow_for_session` option kind. The runtime keeps a per-session map
    /// in `AcpRuntimeSession`; the agent additionally enforces it server-
    /// side via the echoed `optionId`. Distinct from `AllowFuture` so we
    /// can route different `optionId`s back to ACP without conflating
    /// "remember forever" with "remember this session only".
    AllowForSession,
    Deny,
}

#[derive(Debug, Clone)]
pub struct RuntimePermissionResponse {
    pub request_id: String,
    pub decision: RuntimePermissionDecision,
    pub option_id: Option<String>,
    pub feedback: Option<String>,
    pub updated_input: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePermissionResponseKind {
    Normal,
    ContinueOnDeny,
    PlanApproval,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub kind: RuntimeSlashCommandKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeSlashCommandKind {
    Command,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCompactionStrategy {
    /// The runtime drives compaction itself (e.g. via an SDK `compact()`
    /// call) and pushes a summary back to the FE through the regular
    /// event stream.
    LiveRuntime,
}

#[derive(Debug, Clone)]
pub struct RuntimePermissionRequest {
    pub request_id: String,
    /// Runtime-side identifier of the specific tool invocation being gated —
    /// `call_...` on OpenCode; maps to the `tool_use_id` column used when
    /// updating `agent_messages` rows. Absent when the runtime doesn't
    /// surface one (Claude Code doesn't surface these permission events at
    /// all; it uses the direct `can_use_tool` hook instead).
    pub tool_use_id: Option<String>,
    pub tool_name: String,
    pub tool_input: Value,
    pub description: Option<String>,
    pub pattern: Option<String>,
    pub preview: Option<String>,
    pub options: Vec<RuntimePermissionOption>,
}

#[derive(Debug, Clone)]
pub struct RuntimePermissionOption {
    pub decision: RuntimePermissionDecision,
    pub option_id: Option<String>,
    pub label: String,
    pub description: String,
    pub collect_feedback: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeToolPermissionRequest {
    pub tool_name: String,
    pub tool_use_id: String,
    pub input: Value,
    pub permission_updates: Vec<RuntimePermissionUpdate>,
    pub blocked_path: Option<String>,
    pub decision_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimePermissionUpdate {
    pub data: Value,
}

#[derive(Debug, Clone)]
pub enum RuntimeToolPermissionResult {
    Allow {
        updated_input: Value,
        updated_permissions: Option<Vec<RuntimePermissionUpdate>>,
        tool_use_id: Option<String>,
    },
    Deny {
        message: String,
        interrupt: Option<bool>,
        tool_use_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct RuntimeEvent {
    metadata: RuntimeEventMetadata,
    kind: RuntimeEventKind,
}

#[derive(Debug, Clone, Default)]
pub struct RuntimeEventMetadata {
    pub session_id: Option<String>,
    pub usage: Option<RuntimeUsage>,
    /// Authoritative context window reported by the provider for this turn
    /// (e.g. from Claude Code's `result.modelUsage[model].contextWindow`).
    /// Populated on turn-complete events; `None` on intermediate events.
    pub context_window: Option<u64>,
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub enum RuntimeEventKind {
    Init(RuntimeInitEvent),
    AssistantMessage {
        message: RuntimeAssistantMessage,
        parent_tool_use_id: Option<String>,
    },
    UserMessage {
        message: RuntimeUserMessage,
        parent_tool_use_id: Option<String>,
    },
    StreamEvent {
        event: RuntimeStreamEvent,
        parent_tool_use_id: Option<String>,
    },
    ToolUseSummary {
        #[allow(dead_code)]
        data: Value,
    },
    Result,
    CompactBoundary {
        metadata: Option<RuntimeCompactMetadata>,
    },
    /// Provider-neutral signal that the underlying transport is degraded
    /// (reconnecting, stalled, reconcile-failed) or recovered. Mapped to
    /// the `session.stream_status` WS envelope so the UI can show a
    /// "Reconnecting…" banner instead of an infinite silent loader.
    /// Hard failures stay on the existing `RuntimeError` channel.
    StreamStatus(RuntimeStreamStatus),
    /// Live slash-command catalog pushed by the agent (today: the ACP
    /// `available_commands_update` notification). Carries the full
    /// list, not a delta — every push replaces the prior snapshot.
    /// `Arc` so the WS bridge can fan out without cloning the vec
    /// per subscriber.
    SlashCommandsUpdated(Arc<Vec<RuntimeSlashCommand>>),
    /// Runtime accepted a user prompt for delivery to the provider. The
    /// frontend uses this to clear "not received yet" UI.
    PromptReceived {
        client_message_id: String,
    },
    Other,
}

/// Lifecycle of the agent's underlying transport, surfaced provider-neutral
/// so any adapter (today only OpenCode emits these) can opt in. OpenCode ACP emits this from provider-specific workaround paths when needed.
#[derive(Debug, Clone)]
pub enum RuntimeStreamStatus {
    /// The transport is degraded (reconnecting, no heartbeat, reconcile
    /// failed). Carries a free-form reason for logging / tooltip.
    Degraded { reason: String },
    /// The transport recovered after a degraded period. The UI banner
    /// should clear.
    Recovered,
}

/// Provider-neutral metadata captured from a compaction boundary event.
///
/// Cadencr persists this alongside the `compact_divider` block so the UI can
/// surface why the compaction happened and how many tokens were freed.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RuntimeCompactMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RuntimeInitEvent {
    pub model: Option<String>,
    pub mcp_servers: Vec<RuntimeMcpServerStatus>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct RuntimeAssistantMessage {
    pub model: Option<String>,
    pub content: Vec<RuntimeContentBlock>,
}

#[derive(Debug, Clone)]
pub struct RuntimeUserMessage {
    pub content: Vec<RuntimeUserContentBlock>,
}

#[derive(Debug, Clone)]
pub enum RuntimeContentBlock {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeUserContentBlock {
    ToolResult {
        tool_use_id: Option<String>,
        is_error: bool,
        content: Value,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeStreamEvent {
    MessageStart {
        model: Option<String>,
        input_tokens: Option<u64>,
    },
    ContentBlockStart {
        index: u64,
        block: RuntimeContentBlock,
    },
    ContentBlockDelta {
        index: u64,
        delta: RuntimeContentDelta,
    },
    ContentBlockStop {
        index: u64,
    },
    Other,
}

#[derive(Debug, Clone)]
pub enum RuntimeContentDelta {
    Text { text: String },
    Thinking { thinking: String },
    InputJson { partial_json: String },
}

impl RuntimeEvent {
    pub fn new(metadata: RuntimeEventMetadata, kind: RuntimeEventKind) -> Self {
        Self { metadata, kind }
    }

    pub fn session_id(&self) -> Option<&str> {
        self.metadata.session_id.as_deref()
    }

    pub fn usage(&self) -> Option<&RuntimeUsage> {
        self.metadata.usage.as_ref()
    }

    pub fn context_window(&self) -> Option<u64> {
        self.metadata.context_window
    }

    pub fn is_result(&self) -> bool {
        matches!(self.kind, RuntimeEventKind::Result)
    }

    pub fn raw_json(&self) -> &Value {
        &self.metadata.raw
    }

    pub fn init(&self) -> Option<&RuntimeInitEvent> {
        match &self.kind {
            RuntimeEventKind::Init(init) => Some(init),
            _ => None,
        }
    }

    pub fn assistant_message(&self) -> Option<&RuntimeAssistantMessage> {
        match &self.kind {
            RuntimeEventKind::AssistantMessage { message, .. } => Some(message),
            _ => None,
        }
    }

    pub fn user_message(&self) -> Option<&RuntimeUserMessage> {
        match &self.kind {
            RuntimeEventKind::UserMessage { message, .. } => Some(message),
            _ => None,
        }
    }

    pub fn parent_tool_use_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::AssistantMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::UserMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::StreamEvent {
                parent_tool_use_id, ..
            } => parent_tool_use_id.as_deref(),
            _ => None,
        }
    }

    /// Override the event's `parent_tool_use_id` on both the typed kind and
    /// the raw JSON envelope shipped to the frontend. Provider adapters use
    /// this to nest sub-agent events under a parent tool_use without having
    /// to thread the id through every event-builder helper.
    pub fn set_parent_tool_use_id(&mut self, parent: Option<String>) {
        match &mut self.kind {
            RuntimeEventKind::AssistantMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::UserMessage {
                parent_tool_use_id, ..
            }
            | RuntimeEventKind::StreamEvent {
                parent_tool_use_id, ..
            } => {
                *parent_tool_use_id = parent.clone();
            }
            _ => {}
        }
        if let Value::Object(map) = &mut self.metadata.raw {
            let value = match parent {
                Some(id) => Value::String(id),
                None => Value::Null,
            };
            map.insert("parent_tool_use_id".to_string(), value);
        }
    }

    pub fn stream_event(&self) -> Option<&RuntimeStreamEvent> {
        match &self.kind {
            RuntimeEventKind::StreamEvent { event, .. } => Some(event),
            _ => None,
        }
    }

    #[allow(dead_code)]
    pub fn tool_use_summary_data(&self) -> Option<&Value> {
        match &self.kind {
            RuntimeEventKind::ToolUseSummary { data } => Some(data),
            _ => None,
        }
    }

    pub fn is_compact_boundary(&self) -> bool {
        matches!(self.kind, RuntimeEventKind::CompactBoundary { .. })
    }

    pub fn compact_metadata(&self) -> Option<&RuntimeCompactMetadata> {
        match &self.kind {
            RuntimeEventKind::CompactBoundary { metadata } => metadata.as_ref(),
            _ => None,
        }
    }

    pub fn stream_status(&self) -> Option<&RuntimeStreamStatus> {
        match &self.kind {
            RuntimeEventKind::StreamStatus(status) => Some(status),
            _ => None,
        }
    }

    /// Live slash-command catalog snapshot pushed by the agent over
    /// ACP `available_commands_update`. The WS bridge fans these out
    /// to subscribers so the FE picker reflects the agent's current
    /// catalog without re-querying.
    pub fn slash_commands_updated(&self) -> Option<&[RuntimeSlashCommand]> {
        match &self.kind {
            RuntimeEventKind::SlashCommandsUpdated(commands) => Some(commands.as_slice()),
            _ => None,
        }
    }

    pub fn prompt_received_client_message_id(&self) -> Option<&str> {
        match &self.kind {
            RuntimeEventKind::PromptReceived { client_message_id } => Some(client_message_id),
            _ => None,
        }
    }

    pub fn prompt_received_event(client_message_id: String) -> Self {
        Self::new(
            RuntimeEventMetadata {
                raw: serde_json::json!({
                    "type": "prompt_received",
                    "client_message_id": client_message_id,
                }),
                ..RuntimeEventMetadata::default()
            },
            RuntimeEventKind::PromptReceived { client_message_id },
        )
    }

    /// Convenience constructor for stream-status events. Emitters don't
    /// have meaningful session_id / usage / context_window metadata for
    /// these — the WS bridge ignores those fields for status envelopes.
    pub fn stream_status_event(status: RuntimeStreamStatus) -> Self {
        Self::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::StreamStatus(status),
        )
    }
}

pub type RuntimeMessageRx = mpsc::Receiver<Result<RuntimeEvent, RuntimeError>>;
pub type RuntimeSessionHandle = Arc<RwLock<Box<dyn AgentRuntimeSession>>>;

#[async_trait]
pub trait RuntimeToolPermissionHandler: Send + Sync {
    async fn can_use_tool(
        &self,
        request: RuntimeToolPermissionRequest,
    ) -> RuntimeToolPermissionResult;
}

#[async_trait]
pub trait AgentRuntimeSession: Send + Sync {
    fn take_message_rx(&mut self) -> RuntimeMessageRx;
    fn context_window(&self) -> Option<u64> {
        None
    }
    fn runtime_control_endpoint(&self) -> Option<String> {
        None
    }
    async fn session_id(&self) -> Option<String>;
    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError>;
    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        let _ = client_message_id;
        self.stream_input(content).await
    }
    async fn interrupt(&self) -> Result<(), RuntimeError>;
    async fn compact(&self) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "compaction is not supported by this runtime",
        ))
    }
    async fn close(&mut self);
    async fn set_model(&self, model: &str) -> Result<(), RuntimeError>;
    async fn set_permission_mode(&self, mode: RuntimePermissionMode) -> Result<(), RuntimeError>;
    fn applies_thinking_effort_in_place(&self) -> bool {
        false
    }
    async fn set_thinking_effort(&self, _effort: Option<String>) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn respond_permission(
        &self,
        _response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "permission responses are not supported by this runtime",
        ))
    }
    fn permission_response_kind(&self, _request_id: &str) -> RuntimePermissionResponseKind {
        RuntimePermissionResponseKind::Normal
    }
    #[allow(dead_code)]
    fn pid(&self) -> Option<u32>;
}

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
    fn catalog_entry(&self) -> super::runtime::ProviderCatalogEntry;

    /// Live catalog entry (may fetch from external service). Defaults to static.
    async fn catalog_entry_live(&self) -> super::runtime::ProviderCatalogEntry {
        self.catalog_entry()
    }

    /// Live catalog entry scoped to a workspace path. Providers whose catalog
    /// includes project-local data (OpenCode agents, commands, etc.) can
    /// override this without forcing global settings pages to pick a cwd.
    async fn catalog_entry_live_for_cwd(
        &self,
        _cwd: Option<&Path>,
    ) -> super::runtime::ProviderCatalogEntry {
        self.catalog_entry_live().await
    }

    /// Extra models contributed by user configuration (e.g. custom Claude Code
    /// model aliases stored in SQLite). Returned entries are merged into the
    /// adapter's catalog; on id collision the user entry wins.
    async fn extra_models(
        &self,
        _read_pool: &sqlx::SqlitePool,
    ) -> Vec<super::runtime::ModelCatalogEntry> {
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

    /// Provider-known context window for a given model id, if the provider
    /// can answer synchronously (e.g. opencode exposes this via its server).
    /// Defaults to `None` — callers must fall back to another source
    /// (usually history persisted from prior `result` events).
    async fn context_window_for_model(&self, _model_id: &str) -> Option<u64> {
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::{mpsc, Barrier, Notify, RwLock};

    use super::{
        AgentRuntimeAdapter, AgentRuntimeSession, RuntimeAssistantMessage, RuntimeContentBlock,
        RuntimeError, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeMessageRx,
        RuntimePermissionDecision, RuntimePermissionResponse, RuntimeSpawnConfig,
        RuntimeStreamEvent,
    };

    fn assistant_event_with_raw() -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                usage: None,
                context_window: None,
                raw: json!({
                    "type": "assistant",
                    "session_id": "root",
                    "parent_tool_use_id": null,
                }),
            },
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content: vec![RuntimeContentBlock::Text { text: "hi".into() }],
                },
                parent_tool_use_id: None,
            },
        )
    }

    #[test]
    fn opencode_cli_not_found_maps_to_structured_runtime_error() {
        let searched = vec![std::path::PathBuf::from("/custom/opencode")];
        let error = RuntimeError::from(opencode_sdk_rs::SdkError::CliNotFound {
            searched: searched.clone(),
        });
        assert!(matches!(
            error,
            RuntimeError::CliNotFound {
                provider: "opencode",
                searched: actual,
            } if actual == searched
        ));
    }

    #[test]
    fn set_parent_tool_use_id_updates_kind_and_raw_envelope() {
        let mut event = assistant_event_with_raw();
        assert!(event.parent_tool_use_id().is_none());

        event.set_parent_tool_use_id(Some("toolu_parent".into()));
        assert_eq!(event.parent_tool_use_id(), Some("toolu_parent"));
        // Raw envelope is what the WS bridge ships to the frontend; it must
        // mirror the typed value so the FE's `parent_tool_use_id` lookup
        // sees the override too.
        assert_eq!(
            event.raw_json()["parent_tool_use_id"],
            json!("toolu_parent")
        );

        // Clearing it is also reflected on the raw envelope (becomes null,
        // not removed, so the FE still sees the field).
        event.set_parent_tool_use_id(None);
        assert!(event.parent_tool_use_id().is_none());
        assert!(event.raw_json()["parent_tool_use_id"].is_null());
    }

    #[test]
    fn set_parent_tool_use_id_is_a_noop_for_kinds_without_parent_field() {
        // Result events don't carry parent_tool_use_id in their kind, but the
        // mutator must still leave them in a valid state without panicking.
        let mut event =
            RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);
        event.set_parent_tool_use_id(Some("toolu_x".into()));
        assert!(event.parent_tool_use_id().is_none());
    }

    #[test]
    fn set_parent_tool_use_id_propagates_to_stream_event_kind() {
        let mut event = RuntimeEvent::new(
            RuntimeEventMetadata {
                session_id: Some("root".into()),
                usage: None,
                context_window: None,
                raw: json!({ "type": "stream_event", "parent_tool_use_id": null }),
            },
            RuntimeEventKind::StreamEvent {
                event: RuntimeStreamEvent::Other,
                parent_tool_use_id: None,
            },
        );
        event.set_parent_tool_use_id(Some("toolu_spawn".into()));
        assert_eq!(event.parent_tool_use_id(), Some("toolu_spawn"));
    }

    struct DummySession;

    #[async_trait]
    impl AgentRuntimeSession for DummySession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            let (_tx, rx) = mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("dummy".to_string())
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: super::RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_thinking_effort(&self, _effort: Option<String>) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

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

    #[tokio::test]
    async fn session_default_permission_response_is_unsupported() {
        let session = DummySession;
        let error = session
            .respond_permission(RuntimePermissionResponse {
                request_id: "req".to_string(),
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: None,
                feedback: None,
                updated_input: None,
            })
            .await
            .expect_err("default session permission response should be unsupported");

        assert!(error
            .to_string()
            .contains("permission responses are not supported"));
    }

    struct PermissionWhileStreamingSession {
        stream_entered: Arc<Barrier>,
        release_stream: Arc<Notify>,
        permission_seen: Arc<AtomicBool>,
    }

    #[async_trait]
    impl AgentRuntimeSession for PermissionWhileStreamingSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            let (_tx, rx) = mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("concurrent".to_string())
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            self.stream_entered.wait().await;
            self.release_stream.notified().await;
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: super::RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn respond_permission(
            &self,
            _response: RuntimePermissionResponse,
        ) -> Result<(), RuntimeError> {
            self.permission_seen.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[tokio::test]
    async fn permission_response_can_run_while_prompt_stream_is_in_flight() {
        let stream_entered = Arc::new(Barrier::new(2));
        let release_stream = Arc::new(Notify::new());
        let permission_seen = Arc::new(AtomicBool::new(false));
        let query = Arc::new(RwLock::new(Box::new(PermissionWhileStreamingSession {
            stream_entered: Arc::clone(&stream_entered),
            release_stream: Arc::clone(&release_stream),
            permission_seen: Arc::clone(&permission_seen),
        }) as Box<dyn AgentRuntimeSession>));

        let stream_query = Arc::clone(&query);
        let stream_task = tokio::spawn(async move {
            let q = stream_query.read().await;
            q.stream_input(json!("prompt")).await
        });
        stream_entered.wait().await;

        let response = RuntimePermissionResponse {
            request_id: "req-second".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            let q = query.read().await;
            q.respond_permission(response).await
        })
        .await
        .expect("permission response should not wait for the prompt turn")
        .unwrap();
        assert!(permission_seen.load(Ordering::SeqCst));

        release_stream.notify_waiters();
        stream_task.await.unwrap().unwrap();
    }
}
