use axum::extract::ws::Message;
use tracing::{debug, warn};

use super::super::protocol::WsEnvelope;
use super::WsSender;
use crate::app_state::AppState;

/// Handle `app` domain actions (cross-feature, app-level concerns).
pub(super) async fn handle_app_action(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    match envelope.action.as_str() {
        "subscribe.session_status" => {
            handle_subscribe_session_status(envelope, sender, app_state).await
        }
        "subscribe.feature_events" => handle_subscribe_feature_events(sender, app_state),
        "subscribe.schedule_events" => handle_subscribe_schedule_events(sender, app_state),
        "subscribe.settings_events" => handle_subscribe_settings_events(sender, app_state),
        "subscribe.forge_status" => {
            super::app_forge::subscribe_forge_status(envelope, sender, app_state).await
        }
        "forge_visibility" => {
            super::app_forge::update_forge_visibility(envelope, sender, app_state).await
        }
        "subscribe.remote_events" => handle_subscribe_remote_events(sender, app_state),
        "subscribe.file_watcher" => {
            handle_subscribe_file_watcher(envelope, sender, app_state).await
        }
        "subscribe.git_status" => handle_subscribe_git_status(envelope, sender, app_state).await,
        "unsubscribe.git_status" => {
            handle_unsubscribe_git_status(envelope, sender, app_state).await
        }
        unknown => {
            debug!(action = %unknown, "unknown app action, ignoring");
        }
    }
}

/// Subscribe the client to real-time `git.status` envelopes for a feature's
/// worktree. Sends an initial snapshot synchronously (as the first
/// `git.status` event), then the watcher pushes updates whenever the worktree
/// changes.
async fn handle_subscribe_git_status(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let feature_id = match envelope.payload.get("feature_id").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            super::send_error(sender, &envelope.id, "BAD_REQUEST", "missing feature_id");
            return;
        }
    };

    match app_state
        .git_watcher
        .subscribe(app_state, feature_id, sender.clone())
        .await
    {
        Ok(snapshot) => {
            let env = WsEnvelope::new(
                "git",
                "status",
                serde_json::to_value(&snapshot).unwrap_or_else(|_| serde_json::json!({})),
            );
            let _ = sender.send(Message::Text(String::from(env).into()));
        }
        Err(e) => {
            warn!(error = %e, feature_id, "failed to subscribe git watcher");
            super::send_error(sender, &envelope.id, "WATCHER_ERROR", &e.to_string());
        }
    }
}

/// Drop one feature's `git.status` subscription on this connection.
async fn handle_unsubscribe_git_status(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let feature_id = envelope.payload.get("feature_id").and_then(|v| v.as_i64());
    let Some(feature_id) = feature_id else {
        super::send_error(sender, &envelope.id, "BAD_REQUEST", "missing feature_id");
        return;
    };
    // Drop only the (feature_id, sender) pair — multiple WS sessions may
    // watch the same feature_id, and a global `unsubscribe(feature_id)`
    // would kick all of them.
    app_state
        .git_watcher
        .unsubscribe_one(feature_id, sender)
        .await;
}

/// Build the per-session status snapshot and enrich each running entry with
/// the server-stamped turn start from the active-turn registry, so a
/// (re)connecting client anchors its elapsed timer to the same instant the
/// host did. The DB has no per-turn start column, so this is the only place
/// the snapshot picks the timestamp up.
async fn session_status_snapshot_with_timers(
    app_state: &AppState,
) -> std::collections::HashMap<String, crate::domain::sessions::models::SessionStatusSnapshotEntry>
{
    let mut states =
        crate::domain::sessions::repository::get_session_status_snapshot(&app_state.read_pool)
            .await
            .unwrap_or_default();
    for entry in states.values_mut() {
        if entry.status == crate::domain::session_status::AgentStatus::Agent {
            entry.turn_started_at_ms = app_state.active_turns.started_at(entry.session_id).await;
        }
    }
    states
}

/// Subscribe the client to real-time per-session status updates.
/// Sends an initial snapshot keyed by `session_id`, then streams
/// incremental [`SessionStatusEvent`]s.
///
/// Every envelope carries a monotonic `seq` (stamped at send time by
/// `SessionStatusBroadcaster`). Snapshots include the current counter so the
/// frontend can reject any snapshot whose seq is older than an update
/// already applied for a session — that's how we close the lag-recovery
/// race where a snapshot would otherwise wipe a fresh live update.
async fn handle_subscribe_session_status(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    // Subscribe FIRST so any update emitted between snapshot read and
    // subscribe is queued in the broadcast buffer rather than lost.
    let mut rx = app_state.session_status_tx.subscribe();

    // Read snapshot AFTER subscribing. Seq is read first so the snapshot's
    // stamped seq is a lower bound: every event with seq > snapshot.seq is
    // guaranteed to flow through `rx` (either because it was emitted after
    // subscribe, or because it was buffered before this line).
    let seq = app_state.session_status_tx.current_seq();
    let states = session_status_snapshot_with_timers(app_state).await;

    let snapshot = WsEnvelope::reply(
        &envelope.id,
        "app",
        "session_status.snapshot",
        serde_json::json!({ "states": states, "seq": seq }),
    );
    let _ = sender.send(Message::Text(String::from(snapshot).into()));

    let sender = sender.clone();
    let app_state = app_state.clone();
    let broadcaster = app_state.session_status_tx.clone();

    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let update = WsEnvelope::new(
                        "app",
                        "session_status.update",
                        serde_json::to_value(&event).unwrap_or_else(|_| serde_json::json!({})),
                    );
                    if sender
                        .send(Message::Text(String::from(update).into()))
                        .is_err()
                    {
                        // WS connection closed
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    warn!(
                        skipped = n,
                        "session status broadcast lagged, sending fresh snapshot",
                    );
                    let states = session_status_snapshot_with_timers(&app_state).await;
                    let seq = broadcaster.current_seq();
                    let snapshot = WsEnvelope::new(
                        "app",
                        "session_status.snapshot",
                        serde_json::json!({ "states": states, "seq": seq }),
                    );
                    if sender
                        .send(Message::Text(String::from(snapshot).into()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });
}

/// How a subscriber recovers when the broadcast channel drops events under it.
enum OnLag {
    /// Re-send a bare event. Safe for cues whose payload only narrows *what* to
    /// refetch: the client falls back to refetching everything, which is still
    /// correct, just broader.
    ResendBare,
    /// Drop it. For one-shot notifications, where synthesizing an event would
    /// announce something that never happened.
    Skip,
}

/// Forward a global broadcast channel to one client as `app/<action>` envelopes
/// until the socket closes.
///
/// None of the `app`-domain cues carry a `seq` or a snapshot — each is a hint to
/// refetch, not state to merge — so they differ only in the channel, the action
/// name and what a lagged subscriber deserves. Keeping one loop is what stops
/// four near-identical ones from drifting apart. `session_status` stays separate:
/// it has a seq and re-snapshots on lag.
fn forward_app_events<T: serde::Serialize + Clone + Send + 'static>(
    sender: &WsSender,
    mut rx: tokio::sync::broadcast::Receiver<T>,
    action: &'static str,
    on_lag: OnLag,
) {
    let sender = sender.clone();
    tokio::spawn(async move {
        loop {
            // Selected on rather than left to the send below: `WsSender` is
            // unbounded, so a closed socket is only noticed when there is
            // something to send. A channel that can be quiet for hours (a
            // schedule that runs nightly) would otherwise park one task per
            // disconnected client until its next event.
            let payload = tokio::select! {
                _ = sender.closed() => break,
                received = rx.recv() => match received {
                    Ok(event) => {
                        serde_json::to_value(&event).unwrap_or_else(|_| serde_json::json!({}))
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => match on_lag {
                        OnLag::ResendBare => serde_json::json!({}),
                        OnLag::Skip => continue,
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            };
            let update = WsEnvelope::new("app", action, payload);
            if sender
                .send(Message::Text(String::from(update).into()))
                .is_err()
            {
                break;
            }
        }
    });
}

/// Global feature-lifecycle events. No snapshot — the client already has the
/// feature list via REST; each event is just a cue to refetch.
fn handle_subscribe_feature_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.feature_events_tx.subscribe(),
        "feature_event",
        OnLag::ResendBare,
    );
}

/// Global "a schedule ran" events. A schedule fires on the server's clock, into
/// a conversation the client need not have open, so this is the only thing that
/// tells the schedules sidebar its rules moved.
fn handle_subscribe_schedule_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.schedule_events_tx.subscribe(),
        "schedule_event",
        OnLag::ResendBare,
    );
}

/// Settings-file change events — a settings JSON file changed on disk, via our
/// own write or an external editor.
fn handle_subscribe_settings_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.settings_events_tx.subscribe(),
        "settings_event",
        OnLag::ResendBare,
    );
}

/// Remote device-connection events, which the host turns into a "device
/// connected" toast. Only the host (loopback) UI subscribes, so a device never
/// toasts for its own connection. A missed event is a missed toast, not stale
/// state — hence [`OnLag::Skip`].
fn handle_subscribe_remote_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.remote_events_tx.subscribe(),
        "remote_connected",
        OnLag::Skip,
    );
}

/// Subscribe the client to file-system change events for an editor root.
/// The client supplies database ids, never a filesystem path; the backend
/// resolves and validates the authoritative project/worktree root.
async fn handle_subscribe_file_watcher(
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
    let project_path = match crate::domain::projects::service::resolve_feature_editor_root(
        &app_state.read_pool,
        project_id,
        feature_id,
    )
    .await
    {
        Ok(path) => path.to_string_lossy().into_owned(),
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

    // Start or replace the file watcher
    {
        let mut watcher = match app_state.file_watcher.lock() {
            Ok(watcher) => watcher,
            Err(poisoned) => {
                warn!("file watcher lock was poisoned; recovering state");
                app_state.file_watcher.clear_poison();
                poisoned.into_inner()
            }
        };
        if let Err(e) = watcher.start(&project_path, app_state.file_change_tx.clone()) {
            warn!(error = %e, "failed to start file watcher");
            super::send_error(sender, &envelope.id, "WATCHER_ERROR", &e);
            return;
        }
    }

    // ACK subscription
    let ack = WsEnvelope::reply(
        &envelope.id,
        "app",
        "file_watcher.subscribed",
        serde_json::json!({}),
    );
    let _ = sender.send(Message::Text(String::from(ack).into()));

    // Forward file change events to this WS client
    let mut rx = app_state.file_change_tx.subscribe();
    let sender = sender.clone();

    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let update = WsEnvelope::new(
                        "editor",
                        "file_tree.changed",
                        serde_json::json!({ "project_path": event.project_path }),
                    );
                    if sender
                        .send(Message::Text(String::from(update).into()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Just send one notification — the frontend will refetch anyway
                    let update =
                        WsEnvelope::new("editor", "file_tree.changed", serde_json::json!({}));
                    if sender
                        .send(Message::Text(String::from(update).into()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });
}
