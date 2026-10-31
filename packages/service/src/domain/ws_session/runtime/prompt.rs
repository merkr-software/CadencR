mod bridge;
mod bridge_user_message;
pub(in crate::domain::ws_session) mod content;
mod conversation_references;
mod errors;
pub(in crate::domain::ws_session) mod mcp_servers;
mod prompt_checkpoint;
pub(in crate::domain::ws_session) mod prompt_followup;
pub(in crate::domain::ws_session) mod prompt_pending;
mod prompt_pending_mcp;
mod prompt_receipt;
mod prompt_resume_resolution;
pub(in crate::domain::ws_session) mod prompt_runtime_config;
pub(in crate::domain::ws_session) mod prompt_selection_sync;
mod prompt_status;
pub(in crate::domain::ws_session) mod prompt_worktree;
mod runtime_hold;
pub(in crate::domain::ws_session) mod runtime_hold_registry;
mod runtime_mcp;
mod stream_diagnostics;
mod stream_reader;
mod stream_reader_after_turn;
mod stream_reader_background_agents;
mod stream_reader_forward;
mod stream_reader_idle;
mod stream_reader_persistence_health;
mod stream_reader_resume;
mod stream_reader_stop;
mod stream_reader_subagents;
mod stream_reader_task;
mod stream_reader_task_completion;
mod stream_reader_task_error;
mod stream_reader_task_event;
mod stream_reader_task_lifecycle;
mod stream_reader_turn_state;
mod stream_reader_usage;
mod user_message_delivery;
pub(in crate::domain::ws_session) mod user_shell_context;
pub(in crate::domain::ws_session) mod user_shell_local;
pub(in crate::domain::ws_session) mod user_shell_payload;
pub(in crate::domain::ws_session) mod user_shell_recovery;

pub(crate) use bridge::PermissionResponse;
pub(crate) use bridge::WsBridgeCanUseTool;
pub(in crate::domain::ws_session) use prompt_status::mark_agent_running;
pub(crate) use prompt_status::{
    persist_and_publish_user_message, publish_user_message, CanonicalUserMessageMode,
    CanonicalUserMessageRequest,
};
#[allow(unused_imports)]
pub(crate) use stream_reader::spawn_stream_reader;
