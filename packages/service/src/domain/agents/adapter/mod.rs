mod adapter_trait;
mod branching;
mod config;
mod error;
mod event;
mod event_types;
mod permission;
mod session;
mod user_shell;

pub use adapter_trait::AgentRuntimeAdapter;
pub use branching::{BranchContext, BranchError, BranchResult, SessionBranching};
pub use config::{
    access_mode_wire, parse_access_mode_wire, RuntimeAccessMode, RuntimeMcpServerConfig,
    RuntimeMcpServerStatus, RuntimePermissionMode, RuntimeSpawnConfig, RuntimeTokenUsage,
    RuntimeTokenUsageEntry, RuntimeUsage,
};
pub use error::RuntimeError;
pub use event_types::{
    BackgroundAgentSignal, RuntimeAssistantMessage, RuntimeCompactMetadata, RuntimeContentBlock,
    RuntimeContentDelta, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeInitEvent,
    RuntimeResultError, RuntimeStreamEvent, RuntimeStreamStatus, RuntimeTurnStartedSource,
    RuntimeUserContentBlock, RuntimeUserMessage,
};
pub use permission::{
    RuntimeCompactionStrategy, RuntimePermissionDecision, RuntimePermissionOption,
    RuntimePermissionRequest, RuntimePermissionResponse, RuntimePermissionResponseKind,
    RuntimePermissionUpdate, RuntimePromptCommandPlacement, RuntimePromptCommandPolicy,
    RuntimeSkillReferenceTrigger, RuntimeSlashCommand, RuntimeSlashCommandKind,
    RuntimeToolPermissionRequest, RuntimeToolPermissionResult,
};
#[cfg(test)]
pub(crate) use session::test_support::DummySession;
pub use session::{
    AgentRuntimeSession, RuntimeMessageRx, RuntimeSessionHandle, RuntimeSessionWeakHandle,
    RuntimeToolPermissionHandler,
};
pub use user_shell::RuntimeUserShellStrategy;
