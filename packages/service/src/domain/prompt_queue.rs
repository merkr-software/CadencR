//! Prompts the user queued for after the agent's current turn.
//!
//! The composer's "queue" gesture (⌘Enter while the agent works) parks a
//! message here instead of steering the running turn. One is delivered per
//! finished turn, oldest first, as an ordinary user message (persisted and
//! mirrored like any prompt); until then it can be edited, deleted or sent
//! right away. Changes broadcast a bare `{session_id}` ping on
//! `prompt_queue_events_tx`; clients re-fetch the list.

pub(crate) mod acceptance;
pub mod delivery;
pub mod routes;
pub mod store;

/// Ping that a session's prompt queue changed (enqueue, edit, delete, delivery).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptQueueChangedEvent {
    pub session_id: i64,
}

/// Notify every subscribed client that `session_id`'s queue changed.
pub(crate) fn notify_changed(state: &crate::app_state::AppState, session_id: i64) {
    // No subscriber is fine: nobody is looking at that queue right now.
    let _ = state
        .prompt_queue_events_tx
        .send(PromptQueueChangedEvent { session_id });
}
