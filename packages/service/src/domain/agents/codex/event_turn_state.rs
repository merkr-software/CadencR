//! Root-thread turn tracking for the Codex event loop.
//!
//! Codex multiplexes the root and every sub-agent thread on a single
//! JSON-RPC stream. The session's interrupt path needs to know:
//! - the live root turn id (so `turn/interrupt` targets it), and
//! - the most recent root turn id ever seen (fallback for the race
//!   between Stop and the next `turn/started`).
//!
//! Mutating either piece of state from a sub-agent's `turn/started` or
//! `turn/completed` notification is the bug we're guarding against here:
//! a sub-agent finishing used to clear the root's `active_turn_id`,
//! making a subsequent Stop a no-op.

use std::sync::Arc;

use tokio::sync::RwLock;

use super::event_items::item_type;
use super::events::turn_id_from_started;

/// Tracks the root thread's turn ids for the event loop. Bundling these
/// avoids the "too many arguments" clippy warning on the spawn function
/// and keeps the three pieces of state that always travel together as a
/// unit.
pub(super) struct RootTurnTracker {
    /// Live turn id while the root is producing output. Cleared on
    /// `turn/completed`. Sub-agent turn boundaries do NOT touch this.
    pub active_turn_id: Arc<RwLock<Option<String>>>,
    /// Most recent root turn id we've ever seen. Never cleared. Used as
    /// the interrupt fallback when `active_turn_id` is `None` due to a
    /// race between Stop and the next `turn/started`.
    pub last_root_turn_id: Arc<RwLock<Option<String>>>,
    /// Root thread id for this session; used to ignore sub-agent
    /// turn/started + turn/completed events that arrive on the same
    /// multiplexed stream.
    pub root_thread_id: String,
}

pub(super) async fn update_turn_state(
    method: &str,
    params: &serde_json::Value,
    active_turn_id: &Arc<RwLock<Option<String>>>,
    last_root_turn_id: &Arc<RwLock<Option<String>>>,
    root_thread_id: &str,
) {
    // Sub-agent turn/started and turn/completed must not mutate the
    // root's active_turn_id — otherwise a sub-agent finishing clears the
    // root's id mid-turn and the next Stop click sends turn/interrupt
    // with no id.
    if !belongs_to_root_thread(params, root_thread_id) {
        return;
    }

    if method == "turn/started" {
        if let Some(turn_id) = turn_id_from_started(params) {
            *active_turn_id.write().await = Some(turn_id.clone());
            *last_root_turn_id.write().await = Some(turn_id);
        }
    }
    if method == "item/started" && is_context_compaction_item(params) {
        if let Some(turn_id) = params.get("turnId").and_then(serde_json::Value::as_str) {
            *active_turn_id.write().await = Some(turn_id.to_string());
            *last_root_turn_id.write().await = Some(turn_id.to_string());
        }
    }
    if method == "turn/completed" {
        *active_turn_id.write().await = None;
    }
    if method == "item/completed" && is_context_compaction_item(params) {
        let Some(turn_id) = params.get("turnId").and_then(serde_json::Value::as_str) else {
            return;
        };
        let mut active_turn = active_turn_id.write().await;
        if active_turn.as_deref() == Some(turn_id) {
            *active_turn = None;
        }
    }
}

/// Whether a notification's `threadId` belongs to the root conversation.
///
/// Notifications without a `threadId` (rare; some completion-style frames
/// omit it) are treated as root so we don't accidentally swallow the
/// root's turn boundaries.
pub(super) fn belongs_to_root_thread(params: &serde_json::Value, root_thread_id: &str) -> bool {
    match params.get("threadId").and_then(serde_json::Value::as_str) {
        Some(thread_id) => thread_id == root_thread_id,
        None => true,
    }
}

fn is_context_compaction_item(params: &serde_json::Value) -> bool {
    item_type(params) == Some("contextCompaction")
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::RwLock;

    use super::update_turn_state;

    #[tokio::test]
    async fn turn_started_and_completed_update_active_turn_state() {
        let active_turn_id = Arc::new(RwLock::new(None));
        let last_root_turn_id = Arc::new(RwLock::new(None));

        update_turn_state(
            "turn/started",
            &json!({ "threadId": "thread_root", "turn": { "id": "turn_1" } }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("turn_1"));
        assert_eq!(last_root_turn_id.read().await.as_deref(), Some("turn_1"));

        update_turn_state(
            "turn/completed",
            &json!({ "threadId": "thread_root" }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert!(active_turn_id.read().await.is_none());
        // last_root_turn_id is intentionally NOT cleared on completion — it
        // is the fallback handle that lets a Stop after turn/completed still
        // reach the CLI for the previous turn id.
        assert_eq!(last_root_turn_id.read().await.as_deref(), Some("turn_1"));
    }

    #[tokio::test]
    async fn subagent_turn_events_do_not_clobber_root_active_turn() {
        // Repro for the live bug: a sub-agent's turn/completed used to clear
        // the root's active_turn_id, so the next Stop click hit the early
        // return in CodexSession::interrupt and turn/interrupt was never sent.
        let active_turn_id = Arc::new(RwLock::new(None));
        let last_root_turn_id = Arc::new(RwLock::new(None));

        update_turn_state(
            "turn/started",
            &json!({ "threadId": "thread_root", "turn": { "id": "root_turn" } }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;

        // Sub-agent thread emits its own turn/started + turn/completed on the
        // same stream; both must be ignored by the root's bookkeeping.
        update_turn_state(
            "turn/started",
            &json!({ "threadId": "thread_child", "turn": { "id": "subagent_turn" } }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("root_turn"));
        assert_eq!(last_root_turn_id.read().await.as_deref(), Some("root_turn"));

        update_turn_state(
            "turn/completed",
            &json!({ "threadId": "thread_child" }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("root_turn"));
    }

    #[tokio::test]
    async fn context_compaction_item_updates_active_turn_state() {
        let active_turn_id = Arc::new(RwLock::new(None));
        let last_root_turn_id = Arc::new(RwLock::new(None));

        update_turn_state(
            "item/started",
            &json!({
                "threadId": "thread_root",
                "turnId": "compact_turn",
                "item": { "type": "contextCompaction", "id": "compact_1" }
            }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("compact_turn"));

        update_turn_state(
            "item/completed",
            &json!({
                "threadId": "thread_root",
                "turnId": "compact_turn",
                "item": { "type": "contextCompaction", "id": "compact_1" }
            }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert!(active_turn_id.read().await.is_none());
    }

    #[tokio::test]
    async fn turn_completed_without_thread_id_clears_active_turn() {
        // Some completion-style frames omit `threadId`. Treat them as root
        // so we don't accidentally swallow the root's turn boundary.
        let active_turn_id = Arc::new(RwLock::new(Some("root_turn".to_string())));
        let last_root_turn_id = Arc::new(RwLock::new(Some("root_turn".to_string())));

        update_turn_state(
            "turn/completed",
            &json!({}),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert!(active_turn_id.read().await.is_none());
        // last_root_turn_id intentionally stays for fallback use.
        assert_eq!(last_root_turn_id.read().await.as_deref(), Some("root_turn"));
    }

    #[tokio::test]
    async fn context_compaction_completion_keeps_unmatched_active_turn() {
        let active_turn_id = Arc::new(RwLock::new(Some("regular_turn".to_string())));
        let last_root_turn_id = Arc::new(RwLock::new(Some("regular_turn".to_string())));

        update_turn_state(
            "item/completed",
            &json!({
                "threadId": "thread_root",
                "turnId": "compact_turn",
                "item": { "type": "contextCompaction", "id": "compact_1" }
            }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("regular_turn"));

        update_turn_state(
            "item/completed",
            &json!({
                "threadId": "thread_root",
                "item": { "type": "contextCompaction", "id": "compact_1" }
            }),
            &active_turn_id,
            &last_root_turn_id,
            "thread_root",
        )
        .await;
        assert_eq!(active_turn_id.read().await.as_deref(), Some("regular_turn"));
    }
}
