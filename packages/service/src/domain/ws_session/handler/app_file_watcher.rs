//! `app.subscribe.file_watcher`: point the client's editor file-watcher
//! subscription at the feature it shows.
//!
//! Runs off the App WebSocket's ordered lane with per-sender latest-wins
//! cancellation owned by `EditorWatchers` (mirroring
//! `git_watcher.subscribe_in_background`), so a slow filesystem or OS watcher
//! setup never blocks subsequent app subscriptions.

use axum::extract::ws::Message;
use tracing::warn;

use super::super::protocol::WsEnvelope;
use super::WsSender;
use crate::app_state::AppState;
use crate::shared::discard::IgnoreClosed;

/// Point the client's single file-watcher subscription at an editor root,
/// replacing the one it held (see `EditorWatchers`).
/// The client supplies database ids, never a filesystem path; the backend
/// resolves and validates the authoritative project/worktree root.
pub(super) async fn subscribe_file_watcher(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let project_id = match envelope
        .payload
        .get("project_id")
        .and_then(|value| value.as_i64())
    {
        Some(id) => id,
        None => {
            super::send_error(sender, &envelope.id, "BAD_REQUEST", "missing project_id");
            return;
        }
    };
    let feature_id = envelope
        .payload
        .get("feature_id")
        .and_then(|value| value.as_i64());

    let pool = app_state.read_pool.clone();
    let reply = sender.clone();
    let envelope_id = envelope.id;
    app_state.editor_watchers.subscribe_in_background(
        sender.clone(),
        feature_id,
        async move {
            crate::domain::projects::service::resolve_feature_editor_root(
                &pool, project_id, feature_id,
            )
            .await
        },
        move |result| match result {
            Ok(Ok(())) => {
                let ack = WsEnvelope::reply(
                    &envelope_id,
                    "app",
                    "file_watcher.subscribed",
                    serde_json::json!({}),
                );
                reply
                    .send(Message::Text(String::from(ack).into()))
                    .ignore_closed();
            }
            Err(error) => {
                warn!(project_id, feature_id, error = %error, "invalid file watcher root");
                super::send_error(
                    &reply,
                    &envelope_id,
                    "BAD_REQUEST",
                    "invalid project or feature",
                );
            }
            Ok(Err(error)) => {
                warn!(error = %error, "failed to start file watcher");
                super::send_error(&reply, &envelope_id, "WATCHER_ERROR", &error);
            }
        },
    );
}
