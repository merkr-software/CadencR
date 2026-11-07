//! Streaming Claude CLI query module.
//!
//! Public surface: [`Query`], [`TurnState`], [`query`],
//! [`supported_commands`], [`supported_models`],
//! [`supported_models_with_env`].
//!
//! Layout:
//! - [`turn_state`] — [`TurnState`] enum (turn/UI state machine)
//! - [`wire`] — control-protocol parsers + shared `write_to_stdin`
//! - [`query_struct`] — the [`Query`] handle, lifecycle + accessors
//! - [`control_commands`] — `set_*` methods and the control request
//!   round-trip helper
//! - [`reader`] — background CLI-stdout reader loop
//! - [`permission_dispatch`] — spawned task that runs `can_use_tool`
//! - [`spawn`] — top-level [`query`] constructor
//! - [`metadata`] — one-shot `supported_commands` / `supported_models`

mod control_commands;
mod interrupt;
mod mcp_status;
mod metadata;
mod permission_dispatch;
mod permission_requests;
mod query_struct;
mod reader;
mod reader_task;
mod spawn;
mod turn_state;
mod wire;

#[cfg(test)]
mod test_support;

pub use metadata::{supported_commands, supported_models, supported_models_with_env};
pub use query_struct::Query;
pub use spawn::query;
pub use turn_state::TurnState;
