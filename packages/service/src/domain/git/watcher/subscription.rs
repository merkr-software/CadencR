//! Subscription-level helpers used by `GitWatcherRegistry`: dedupe on
//! sender identity, resolve the worktree path for a
//! feature, and the synchronous `recompute_and_broadcast` entrypoint used by
//! the commit/push/target-branch handlers.

use crate::shared::discard::IgnoreClosed;
use std::path::PathBuf;

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use super::handle::{sender_eq, Subscriber};
use crate::app_state::AppState;
use crate::domain::ws_session::protocol::WsEnvelope;
use crate::error::AppError;

/// Serialize `envelope` once and ship a clone to every sender. Shared by
/// both the locked and lock-free broadcast paths.
pub(super) fn broadcast_envelope(
    senders: &[mpsc::UnboundedSender<Message>],
    envelope: &WsEnvelope,
) {
    if senders.is_empty() {
        return;
    }
    let payload = String::from(envelope.clone());
    for tx in senders {
        tx.send(Message::Text(payload.clone().into()))
            .ignore_closed();
    }
}

pub(crate) fn status_error_payload(feature_id: i64, error: &AppError) -> serde_json::Value {
    serde_json::json!({ "feature_id": feature_id, "error": error.to_string() })
}

/// Insert a `(feature_id, sender)` subscription, but skip the insert if a
/// subscriber with the same `feature_id` and the same underlying channel
/// already exists. Two `subscribe.git_status` envelopes from the same WS
/// connection for the same feature would otherwise duplicate every status
/// envelope on the wire.
pub(super) fn push_subscriber_dedup(
    subscribers: &mut Vec<Subscriber>,
    feature_id: i64,
    sender: mpsc::UnboundedSender<Message>,
) {
    let already_subscribed = subscribers
        .iter()
        .any(|s| s.feature_id == feature_id && sender_eq(&s.sender, &sender));
    if already_subscribed {
        return;
    }
    subscribers.push(Subscriber { feature_id, sender });
}

/// Resolve the canonical checkout path for a feature. The shared Git
/// path resolver rejects stale worktree settings and falls back to the project
/// root before this function canonicalizes the result.
pub(super) async fn resolve_worktree_path(
    state: &AppState,
    feature_id: i64,
) -> Result<PathBuf, AppError> {
    let git_path = crate::domain::git::service::resolve_feature_working_path(state, feature_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("feature {feature_id} has no git path")))?;
    let canonical = tokio::fs::canonicalize(&git_path)
        .await
        .unwrap_or_else(|_| PathBuf::from(&git_path));
    Ok(canonical)
}

/// Recompute and broadcast the snapshot for a single feature immediately
/// after a write completes (commit, push, target-branch PATCH). Two halves:
///
/// 1. `nudge()` sets the dedupe window so the trail of self-induced fs
///    events the write produced (`.git/index`, `refs/remotes/origin/*`, …)
///    is silently dropped instead of triggering another recompute behind
///    our back.
/// 2. **Synchronous** `compute_status` + broadcast so the WS `git.status`
///    envelope (and the React Query invalidation it drives on the
///    frontend) lands *before* the HTTP response. Bypasses the watcher's
///    `MIN_RECOMPUTE_GAP_MS` queue, which is for fs-event coalescing, not
///    for user-initiated writes.
///
/// Without #2, a user clicking Push and watching the dialog would see the
/// "1 commit to push" indicator linger for up to one second after the push
/// completed — long enough to read as a bug rather than a refresh hop.
pub async fn recompute_and_broadcast(state: &AppState, feature_id: i64) -> Result<(), AppError> {
    let worktree_path = resolve_worktree_path(state, feature_id).await?;
    state
        .git_watcher
        .confirm_after_write(&worktree_path, state)
        .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_subscriber_dedupes_same_channel_for_same_feature() {
        let (tx, _rx) = mpsc::unbounded_channel::<Message>();
        let mut subscribers = Vec::new();

        push_subscriber_dedup(&mut subscribers, 7, tx.clone());
        push_subscriber_dedup(&mut subscribers, 7, tx.clone());
        push_subscriber_dedup(&mut subscribers, 8, tx.clone());

        assert_eq!(subscribers.len(), 2);
        assert_eq!(subscribers[0].feature_id, 7);
        assert_eq!(subscribers[1].feature_id, 8);
    }
}
