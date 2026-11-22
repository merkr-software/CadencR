use axum::extract::ws::Message;

use super::super::protocol::WsEnvelope;
use super::WsSender;
use crate::app_state::AppState;
use crate::domain::git::forge::PrStatusSnapshot;

/// Subscribe one app-level socket to PR/MR status for every feature. This is
/// deliberately separate from per-feature git-watcher subscriptions: sidebar
/// rows need forge status even when their Git panes were never mounted.
pub(super) async fn subscribe_forge_status(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let Some(client_id) = client_id(&envelope) else {
        super::send_error(
            sender,
            &envelope.id,
            "BAD_REQUEST",
            "missing forge client_id",
        );
        return;
    };
    let visible = envelope
        .payload
        .get("visible")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    app_state
        .forge_activity
        .register(client_id.clone(), visible)
        .await;
    let mut rx = app_state.forge_events_tx.subscribe();
    if send_snapshots(sender, app_state.forge_status.list().await)
        .await
        .is_err()
    {
        app_state.forge_activity.remove(&client_id).await;
        return;
    }
    let sender = sender.clone();
    let state = app_state.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = sender.closed() => break,
                result = rx.recv() => match result {
                    Ok(snapshot) => {
                        if send_snapshot(&sender, snapshot).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let snapshots = state.forge_status.list().await;
                        if send_snapshots(&sender, snapshots).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            }
        }
        state.forge_activity.remove(&client_id).await;
    });
}

pub(super) async fn update_forge_visibility(
    envelope: WsEnvelope,
    sender: &WsSender,
    app_state: &AppState,
) {
    let Some(client_id) = client_id(&envelope) else {
        super::send_error(
            sender,
            &envelope.id,
            "BAD_REQUEST",
            "missing forge client_id",
        );
        return;
    };
    let Some(visible) = envelope
        .payload
        .get("visible")
        .and_then(serde_json::Value::as_bool)
    else {
        super::send_error(
            sender,
            &envelope.id,
            "BAD_REQUEST",
            "missing forge visibility",
        );
        return;
    };
    app_state.forge_activity.update(&client_id, visible).await;
}

fn client_id(envelope: &WsEnvelope) -> Option<String> {
    envelope
        .payload
        .get("client_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_string)
}

const SNAPSHOT_YIELD_BATCH: usize = 32;

async fn send_snapshots(sender: &WsSender, snapshots: Vec<PrStatusSnapshot>) -> Result<(), ()> {
    for (index, snapshot) in snapshots.into_iter().enumerate() {
        send_snapshot(sender, snapshot)?;
        if (index + 1) % SNAPSHOT_YIELD_BATCH == 0 {
            tokio::task::yield_now().await;
        }
    }
    Ok(())
}

fn send_snapshot(sender: &WsSender, snapshot: PrStatusSnapshot) -> Result<(), ()> {
    let payload = serde_json::to_value(snapshot)
        .expect("PrStatusSnapshot contains only infallibly serializable fields");
    let update = WsEnvelope::new("git", "pr_status", payload);
    sender
        .send(Message::Text(String::from(update).into()))
        .map_err(|_| ())
}
