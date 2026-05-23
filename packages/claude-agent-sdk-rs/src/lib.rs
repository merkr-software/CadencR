#![allow(
    clippy::empty_line_after_doc_comments,
    clippy::large_enum_variant,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::vec_init_then_push
)]

pub mod commands;
pub mod discovery;
pub mod error;
pub mod mcp;
pub mod mcp_discovery;
pub mod messages;
pub mod options;
pub mod permissions;
pub mod query;
pub mod transport;
pub mod types;

// Re-export key public types for convenient top-level access.
pub use commands::{list_builtin_commands, list_commands, list_filesystem_commands};
pub use discovery::{claude_discovery_spec, set_binary_override};
pub use error::SdkError;
pub use mcp::McpServerConfig;
pub use messages::{
    AssistantMessageBody, ModelUsageInfo, SdkMessage, StreamEventData, SystemMessage,
};
pub use options::{Options, OptionsBuilder};
pub use permissions::{
    AllowAllTools, CanUseTool, PermissionMode, PermissionRequest, PermissionResult,
    PermissionUpdate,
};
pub use query::{
    query, supported_commands, supported_models, supported_models_with_env, Query, TurnState,
};
pub use types::{
    AccountInfo, AgentInfo, CompactMetadata, ContentBlock, ContentDelta, McpServerStatus,
    ModelInfo, PermissionDenial, PluginInfo, SlashCommand, Usage,
};
