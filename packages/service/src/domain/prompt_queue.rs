//! Messages queued for after the agent's current turn.
//!
//! Two kinds share one queue per session. The composer's "queue" gesture
//! (⌘Enter while the agent works) parks the user's message here instead of
//! steering the running turn; another session's agent queues one with
//! `delivery=next_turn`. One is delivered per finished turn, the user's own
//! first, oldest first: the user's as an ordinary user message, an agent's as
//! sent by its conversation (see `mcp::control::message_queue`). Until then
//! each can be edited, deleted or sent right away. An agent message also goes
//! out when the session is otherwise idle (`sweep`). Changes broadcast a bare `{session_id}` ping on
//! `prompt_queue_events_tx`; clients re-fetch the list.

use crate::shared::discard::IgnoreClosed;
pub(crate) mod acceptance;
pub mod delivery;
pub mod routes;
pub mod store;
pub mod sweep;

/// Ping that a session's prompt queue changed (enqueue, edit, delete, delivery).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptQueueChangedEvent {
    pub session_id: i64,
}

/// Notify every subscribed client that `session_id`'s queue changed.
pub(crate) fn notify_changed(state: &crate::app_state::AppState, session_id: i64) {
    // No subscriber is fine: nobody is looking at that queue right now.
    state
        .prompt_queue_events_tx
        .send(PromptQueueChangedEvent { session_id })
        .ignore_closed();
}
