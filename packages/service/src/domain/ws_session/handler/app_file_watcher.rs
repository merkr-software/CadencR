//! `app.subscribe.file_watcher`: point the client's editor file-watcher
//! subscription at the feature it shows.

use axum::extract::ws::Message;
use tracing::warn;

use super::super::protocol::WsEnvelope;
use super::WsSender;
use crate::app_state::AppState;

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
    let root = match crate::domain::projects::service::resolve_feature_editor_root(
        &app_state.read_pool,
        project_id,
        feature_id,
    )
    .await
    {
        Ok(path) => path,
        Err(error) => {
            warn!(project_id, feature_id, error = %error, "invalid file watcher root");
            super::send_error(
                sender,
                &envelope.id,
                "BAD_REQUEST",
                "invalid project or feature",
            );
            return;
        }
    };

    if let Err(e) = app_state
        .editor_watchers
        .subscribe(sender, root, feature_id)
        .await
    {
        warn!(error = %e, "failed to start file watcher");
        super::send_error(sender, &envelope.id, "WATCHER_ERROR", &e);
        return;
    }

    let ack = WsEnvelope::reply(
        &envelope.id,
        "app",
        "file_watcher.subscribed",
        serde_json::json!({}),
    );
    let _ = sender.send(Message::Text(String::from(ack).into()));
}
