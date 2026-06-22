//! Session repository — split into focused submodules so each file fits
//! under the 400-line cap. Public surface is re-exported here so the path
//! `crate::domain::sessions::repository::<fn>` stays unchanged for callers.

/// Canonical column list for `agent_messages` reads. Shared so the various
/// fetch helpers in this module can't drift out of sync.
pub(super) const MESSAGE_SELECT: &str = "SELECT id, session_id, content, message_type, tool_name, tool_use_id, parent_tool_use_id, created_at, model";

mod blocks;
mod drafts;
mod feature_state;
mod feature_state_fetch;
mod origins;
mod pagination;
mod queries;
mod task_todos;
mod tool_blocks;
mod truncation;

#[cfg(test)]
mod test_support;

pub use drafts::{get_draft, get_message_content, save_draft};
pub use feature_state::get_feature_agent_state;
pub use queries::{get_session_status_snapshot, get_sessions, latest_assistant_preview};
