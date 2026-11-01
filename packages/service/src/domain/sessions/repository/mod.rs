//! Session repository — split into focused submodules so each file fits
//! under the 400-line cap. Public surface is re-exported here so the path
//! `crate::domain::sessions::repository::<fn>` stays unchanged for callers.

/// Canonical column list for `agent_messages` reads. Shared so the various
/// fetch helpers in this module can't drift out of sync.
pub(super) const MESSAGE_SELECT: &str = "SELECT id, session_id, message_uuid, delivery_state, content, message_type, tool_name, tool_use_id, parent_tool_use_id, created_at, model";

mod block_conversion;
mod blocks;
mod byte_pagination;
mod conversation_references;
mod drafts;
mod feature_state;
mod feature_state_build;
mod feature_state_fetch;
mod incremental_fetch;
mod latest_todos_query;
mod origins;
mod pagination;
mod queries;
mod reply_preview;
mod task_todos;
mod todo_progress;
mod tool_blocks;
mod wire_preview;
// `pub(crate)` so storage maintenance can trim exactly the payloads this module
// truncates on read, against the same canonical tool name.
pub(crate) mod truncation;

#[cfg(test)]
mod test_support;

pub use conversation_references::list_conversation_references;
pub(crate) use conversation_references::{
    resolve_conversation_references, ResolvedConversationReference,
};
pub use drafts::{get_draft, get_message_content, save_draft};
pub use feature_state::get_feature_agent_state;
pub(crate) use origins::{get_message_origin, origin_matches_session_generated};
pub use queries::{get_session_status_snapshot, get_sessions, latest_assistant_preview};
pub(crate) use queries::{parse_turn_models, preview_snippet};
pub use todo_progress::latest_todo_progress;
