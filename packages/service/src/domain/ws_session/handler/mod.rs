//! WebSocket session handler entry point.
//!
//! Production code is split across cohesive submodules:
//!
//! - [`types`] — `SdkHandle`, `QueryState`, `SessionConfig`, channel/lock
//!   type aliases held by `handle_connection`.
//! - [`helpers`] — small utilities (permission-mode parsing, `send_error`,
//!   `persist_and_close_query`) shared across handlers.
//! - [`dispatch`] — domain-level routing of inbound `WsEnvelope`s to the
//!   matching `session_*` / `workflow` / `app` / `commands` handler.
//! - [`connection`] — the axum upgrade hook and the per-connection
//!   inbound/outbound loop, including the disconnect cleanup path.
//!
//! The dispatch-layer integration tests live in the [`tests`] submodule.
//! They are grouped by responsibility into thematic files under `tests/`
//! and exercise the public surface this module re-exports.

mod access;
mod active_turns;
mod app;
mod app_forge;
mod claude_access;
pub(in crate::domain::ws_session) mod commands;
mod connection;
mod dispatch;
pub(crate) mod helpers;
pub(crate) mod post_plan_mode;
mod session_branch;
mod session_compact;
mod session_compact_pending;
mod session_control;
mod session_data;
mod session_gate;
mod session_init;
mod session_init_resume;
mod session_init_worktree;
mod session_profile;
pub(crate) mod session_prompt;
mod session_runtime_config;
mod thinking_effort;
mod types;

pub use connection::ws_handler;
pub use session_prompt::user_shell_recovery::recover_user_shell_context;

// Public type for crate-wide use (referenced via `handler::SdkHandle`).
pub(crate) use session_control::handle_permission_respond;
pub use types::SdkHandle;
pub(crate) use types::{new_sdk_sessions, SdkSessions};

// Process-global registry of which connection owns each session's live turn.
// Held on `AppState` so cross-device permission/question/plan answers and the
// synchronized turn timer can resolve the authoritative owner.
pub use active_turns::ActiveTurnRegistry;

// Re-export the cross-submodule helpers and types into the `handler` module
// scope so the sibling production submodules can reach them via `super::*`
// (e.g. `super::send_error`, `super::WsSender`). These are load-bearing for
// the per-action handlers, not test-only wiring.
#[allow(unused_imports)]
use dispatch::dispatch_envelope;
#[allow(unused_imports)]
use helpers::{
    default_permission_mode, default_permission_mode_wire, parse_permission_mode, parse_session_id,
    persist_and_close_query, post_plan_approval_mode_wire, provider_supports_mode, send_error,
    send_runtime_session_id,
};
#[allow(unused_imports)]
use types::{QueryState, SessionConfig, WsSender};

// Exception to the inline-rust-tests rule: this dispatch-layer test suite is a
// single ~2.5k-line integration suite that cannot stay inline without breaching
// the 400-line file-size cap, so it lives in a `tests/` subtree grouped by
// responsibility. The file-size rule takes precedence here.
#[cfg(test)]
mod tests;
