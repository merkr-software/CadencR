use serde_json::Value;

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

/// How a user's answer to a runtime permission request reaches the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePermissionResponseRoute {
    /// Delivered through `AgentRuntimeSession::respond_permission`.
    Session,
    /// Delivered to the `RuntimeToolPermissionHandler` callback that is
    /// waiting on that request id (the runtime blocks inside the callback).
    PermissionCallback,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RuntimePromptCommandPlacement {
    #[default]
    PromptStart,
    Anywhere,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RuntimeSkillReferenceTrigger {
    #[default]
    Slash,
    Dollar,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RuntimePromptCommandPolicy {
    pub slash_command_placement: RuntimePromptCommandPlacement,
    pub skill_reference_trigger: RuntimeSkillReferenceTrigger,
    /// Whether a leading `!` is a supported user-shell command trigger.
    /// Shared clients consume this capability without identifying providers.
    pub user_shell: bool,
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
