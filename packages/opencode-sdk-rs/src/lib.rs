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
pub mod mcp;
pub mod models;
pub mod parsing;
pub mod permissions;
pub mod process;
mod tool_input;
pub mod types;

pub use client::OpenCodeClient;
pub use error::{CommandStderr, SdkError};
pub use mcp::{
    list_mcp_servers_from_binary, list_mcp_servers_from_cli, list_mcp_servers_from_config_files,
    list_mcp_servers_from_resolved_config, list_mcp_servers_without_resolved_config,
    parse_mcp_config_output, parse_mcp_list_output, OpenCodeMcpServerStatus,
};
pub use models::{list_models_from_cli, parse_models_verbose_output};
pub use parsing::{parse_message_from, parse_session_from};
pub use permissions::{PendingPermission, PermissionReply};
pub use process::{opencode_discovery_spec, resolve_binary, set_binary_override};
pub use types::{
    Agent, Command, ConfigModelLimit, ConfigProvider, ConfigProviderModel, ConfigProvidersResponse,
    Message, MessagePart, MessageRole, ModelRef, Session, SessionStatus, TokenCacheUsage,
    TokenUsage,
};
