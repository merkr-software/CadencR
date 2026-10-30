use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Authoritative list of session-domain server → client action names.
///
/// Keep backend emitters and the generated frontend contract on this enum
/// instead of retyping bare strings at each call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WsSessionAction {
    Initialized,
    Message,
    UsageUpdate,
    Ended,
    Error,
    Deleted,
    Cleared,
    Lifecycle,
    #[serde(rename = "retry_worktree_setup.ok")]
    RetryWorktreeSetupOk,
    #[serde(rename = "gate.closed")]
    GateClosed,
    McpServers,
    UserMessage,
    #[serde(rename = "history.result")]
    HistoryResult,
    #[serde(rename = "history.added")]
    HistoryAdded,
    #[serde(rename = "draft.result")]
    DraftResult,
    #[serde(rename = "draft.saved")]
    DraftSaved,
    #[serde(rename = "access_mode.changed")]
    AccessModeChanged,
    #[serde(rename = "provider.set.ok")]
    ProviderSetOk,
    #[serde(rename = "compact.started")]
    CompactStarted,
    #[serde(rename = "model.set.ok")]
    ModelSetOk,
    #[serde(rename = "effort.set.ok")]
    EffortSetOk,
    #[serde(rename = "config.snapshot")]
    ConfigSnapshot,
    #[serde(rename = "fast_mode.set.ok")]
    FastModeSetOk,
    #[serde(rename = "mode.changed")]
    ModeChanged,
    #[serde(rename = "profile.changed")]
    ProfileChanged,
    #[serde(rename = "runtime_overrides.changed")]
    RuntimeOverridesChanged,
    #[serde(rename = "branch.rewound")]
    BranchRewound,
    #[serde(rename = "branch.forked")]
    BranchForked,
    RuntimeSessionId,
    #[serde(rename = "permission.request")]
    PermissionRequest,
    PromptReceived,
    StreamStatus,
    PersistenceStatus,
}

impl WsSessionAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Initialized => "initialized",
            Self::Message => "message",
            Self::UsageUpdate => "usage_update",
            Self::Ended => "ended",
            Self::Error => "error",
            Self::Deleted => "deleted",
            Self::Cleared => "cleared",
            Self::Lifecycle => "lifecycle",
            Self::RetryWorktreeSetupOk => "retry_worktree_setup.ok",
            Self::GateClosed => "gate.closed",
            Self::McpServers => "mcp_servers",
            Self::UserMessage => "user_message",
            Self::HistoryResult => "history.result",
            Self::HistoryAdded => "history.added",
            Self::DraftResult => "draft.result",
            Self::DraftSaved => "draft.saved",
            Self::AccessModeChanged => "access_mode.changed",
            Self::ProviderSetOk => "provider.set.ok",
            Self::CompactStarted => "compact.started",
            Self::ModelSetOk => "model.set.ok",
            Self::EffortSetOk => "effort.set.ok",
            Self::ConfigSnapshot => "config.snapshot",
            Self::FastModeSetOk => "fast_mode.set.ok",
            Self::ModeChanged => "mode.changed",
            Self::ProfileChanged => "profile.changed",
            Self::RuntimeOverridesChanged => "runtime_overrides.changed",
            Self::BranchRewound => "branch.rewound",
            Self::BranchForked => "branch.forked",
            Self::RuntimeSessionId => "runtime_session_id",
            Self::PermissionRequest => "permission.request",
            Self::PromptReceived => "prompt_received",
            Self::StreamStatus => "stream_status",
            Self::PersistenceStatus => "persistence_status",
        }
    }

    pub const fn all() -> &'static [Self] {
        &[
            Self::Initialized,
            Self::Message,
            Self::UsageUpdate,
            Self::Ended,
            Self::Error,
            Self::Deleted,
            Self::Cleared,
            Self::Lifecycle,
            Self::RetryWorktreeSetupOk,
            Self::GateClosed,
            Self::McpServers,
            Self::UserMessage,
            Self::HistoryResult,
            Self::HistoryAdded,
            Self::DraftResult,
            Self::DraftSaved,
            Self::AccessModeChanged,
            Self::ProviderSetOk,
            Self::CompactStarted,
            Self::ModelSetOk,
            Self::EffortSetOk,
            Self::ConfigSnapshot,
            Self::FastModeSetOk,
            Self::ModeChanged,
            Self::ProfileChanged,
            Self::RuntimeOverridesChanged,
            Self::BranchRewound,
            Self::BranchForked,
            Self::RuntimeSessionId,
            Self::PermissionRequest,
            Self::PromptReceived,
            Self::StreamStatus,
            Self::PersistenceStatus,
        ]
    }
}

impl From<WsSessionAction> for String {
    fn from(action: WsSessionAction) -> Self {
        action.as_str().to_string()
    }
}
