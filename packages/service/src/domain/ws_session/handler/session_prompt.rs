//! WebSocket prompt decoding, request correlation and user-shell routing.
mod prompt_send;
mod prompt_send_entry;
mod prompt_send_pending;
mod prompt_validation;
mod user_shell;

#[allow(unused_imports)]
pub(crate) use super::super::runtime::prompt::spawn_stream_reader;
pub(in crate::domain::ws_session) use super::super::runtime::prompt::{
    mark_agent_running, runtime_hold_registry, user_shell_recovery,
};
pub(crate) use super::super::runtime::prompt::{
    persist_and_publish_user_message, CanonicalUserMessageMode, CanonicalUserMessageRequest,
    PermissionResponse, WsBridgeCanUseTool,
};
pub(crate) use prompt_send_entry::handle_prompt_send;
