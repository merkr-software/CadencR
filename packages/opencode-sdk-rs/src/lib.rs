//! Minimal OpenCode SDK consumed by the Cadencr ACP runtime path.
//!
//! Originally included a full long-lived `opencode serve` transport
//! client plus reconcile / event-parsing pipeline). With that transport
//! retired the surface here is now narrow: typed wire shapes
//! (`types::Message`, `MessagePart`, `Session`, …), binary discovery + CLI
//! override (`process::opencode_discovery_spec`,
//! `process::set_binary_override`, `process::resolve_binary`), and a thin
//! REST client whose only callers are the ACP `upstream_workaround` polling
//! sidecar (which hits the embedded HTTP backend exposed by every
//! `opencode acp --port` subprocess we spawn). Anything broader belongs in
//! a separate transport.

#![allow(clippy::should_implement_trait)]

mod cli_command;
pub mod client;
pub mod error;
mod generation;
pub mod mcp;
pub mod models;
mod models_v2;
pub mod parsing;
pub mod permissions;
pub mod process;
mod standalone_api;
mod tool_input;
pub mod types;

pub use cli_command::{capture_opencode_command, CapturedRun};
pub use client::{OpenCodeClient, SessionMoveOutcome};
pub use error::{CommandStderr, SdkError};
pub use generation::{OpenCodeGeneration, OpenCodeInstallation};
pub use mcp::{
    list_mcp_servers_from_binary, list_mcp_servers_from_cli, list_mcp_servers_from_config_files,
    list_mcp_servers_from_resolved_config, list_mcp_servers_without_resolved_config,
    parse_mcp_config_output, parse_mcp_list_output, OpenCodeMcpServerStatus,
};
pub use models::{list_models_from_cli, parse_models_verbose_output};
pub use models_v2::{list_models_from_api, parse_models_response};
pub use parsing::{parse_message_from, parse_session_from};
pub use permissions::{PendingPermission, PermissionReply};
pub use process::{
    cached_generation, opencode_discovery_spec, resolve_binary, resolve_installation,
    set_binary_override,
};
pub use standalone_api::StandaloneApi;
pub use tool_input::canonical_tool_name;
pub use types::{
    Agent, Command, ConfigModelLimit, ConfigProvider, ConfigProviderModel, ConfigProvidersResponse,
    Message, MessagePart, MessageRole, ModelRef, Session, SessionStatus, TokenCacheUsage,
    TokenUsage,
};
