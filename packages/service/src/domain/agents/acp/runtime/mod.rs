//! Provider-neutral ACP runtime layer.
//!
//! Lifted out of `domain::agents::opencode::acp::*` in W1 so multiple ACP
//! providers can share this code. Provider-specific behavior plugs in
//! through the [`provider_hooks::AcpProviderHooks`] trait.

mod apply_model_config;
pub mod capability_probe;
pub mod config_options;
pub mod event_loop_state;
pub mod events;
pub mod events_config_option;
pub mod events_plan;
pub mod events_stream_blocks;
pub mod events_tool_call;
mod events_tool_call_input;
mod events_tool_call_metadata;
mod events_tool_call_name;
mod events_tool_call_parent;
mod events_tool_call_result;
pub mod events_tool_call_update;
mod events_tool_call_update_result;
pub mod fs;
pub mod lifecycle;
pub mod mcp;
pub mod mode_switch;
pub(crate) mod permission_events;
mod permission_tool_updates;
pub mod permissions;
mod permissions_dispatch;
mod permissions_refresh;
pub mod permissions_typed;
pub mod prompt_receipts;
pub mod prompt_turn;
pub mod provider_hooks;
pub mod schema_bridge;
#[cfg(test)]
mod server_request_event_loop_tests;
mod server_request_extensions;
mod server_request_response;
pub mod server_requests;
pub mod session;
mod session_config;
pub mod session_permissions;
pub mod session_spawn;
#[cfg(test)]
mod session_spawn_integration_tests;
pub(crate) mod slash_command_snapshots;
mod spawn_initial_config;
mod spawn_initial_mode;
#[cfg(test)]
pub mod standard_hooks;
pub mod stream_events;
mod terminal_enrich;
mod terminal_io;
pub mod terminal_registry;
mod terminal_sandbox;
#[cfg(test)]
pub(crate) mod test_support;
pub(crate) mod thought_level;
pub(crate) mod tool_input;
mod trusted_mcp_permissions;
pub mod turn_lifecycle;
pub mod turn_result;

pub use session_spawn::{spawn_acp_runtime_session, AcpRuntimeSpawnArgs};
#[cfg(test)]
pub use standard_hooks::StandardAcpHooks;
