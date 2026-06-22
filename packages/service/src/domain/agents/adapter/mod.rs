mod adapter_trait;
mod config;
mod error;
mod event;
mod event_types;
mod permission;
mod session;

pub use adapter_trait::AgentRuntimeAdapter;
pub use config::{
    RuntimeAccessMode, RuntimeMcpServerConfig, RuntimeMcpServerStatus, RuntimePermissionMode,
    RuntimeSpawnConfig, RuntimeUsage,
};
pub use error::RuntimeError;
pub use event_types::{
    BackgroundAgentSignal, RuntimeAssistantMessage, RuntimeCompactMetadata, RuntimeContentBlock,
    RuntimeContentDelta, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeInitEvent,
    RuntimeStreamEvent, RuntimeStreamStatus, RuntimeTurnStartedSource, RuntimeUserContentBlock,
    RuntimeUserMessage,
};
pub use permission::{
    RuntimeCompactionStrategy, RuntimePermissionDecision, RuntimePermissionOption,
    RuntimePermissionRequest, RuntimePermissionResponse, RuntimePermissionResponseKind,
    RuntimePermissionUpdate, RuntimeSlashCommand, RuntimeSlashCommandKind,
    RuntimeToolPermissionRequest, RuntimeToolPermissionResult,
};
pub use session::{
    AgentRuntimeSession, RuntimeMessageRx, RuntimeSessionHandle, RuntimeToolPermissionHandler,
};
