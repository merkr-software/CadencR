use axum::extract::ws::Message;

use super::super::protocol::WsEnvelope;
use super::app::{forward_app_events, OnLag};
use super::WsSender;
use crate::app_state::AppState;

/// Send the latest running progress before forwarding lifecycle updates.
pub(super) fn subscribe_storage_maintenance(sender: &WsSender, app_state: &AppState) {
    // Subscribe first so a completion emitted while reading the snapshot stays
    // queued. A duplicate update is harmless because the frontend store replaces
    // its single maintenance status.
    let rx = app_state.storage_maintenance_events_tx.subscribe();
    if let Some(event) = app_state.storage_maintenance_events_tx.active() {
        let payload = serde_json::to_value(event).unwrap_or_else(|_| serde_json::json!({}));
        let update = WsEnvelope::new("app", "storage_maintenance", payload);
        let _ = sender.send(Message::Text(String::from(update).into()));
    }
    forward_app_events(sender, rx, "storage_maintenance", OnLag::Skip);
}

/// Remote device connections are one-shot host notifications, not state.
pub(super) fn subscribe_remote_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.remote_events_tx.subscribe(),
        "remote_connected",
        OnLag::Skip,
    );
}

/// Conversations an agent archived (`project_archive_session`): one-shot
/// notifications every client turns into the Archive dialog's local effects.
pub(super) fn subscribe_agent_archived_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.feature_events_tx.subscribe_agent_archived(),
        "agent_archived",
        OnLag::Skip,
    );
}

/// Settings-file changes are cues for the desktop to refetch settings.
pub(super) fn subscribe_settings_events(sender: &WsSender, app_state: &AppState) {
    forward_app_events(
        sender,
        app_state.settings_events_tx.subscribe(),
        "settings_event",
        OnLag::ResendBare,
    );
}

/// Provider version checks and update outcomes, starting with the current
/// list. Each event carries the full list, so a lagged client only needs the
/// next one; a lost outcome is reconciled from `activity` on the client.
pub(super) fn subscribe_provider_update_events(sender: &WsSender, app_state: &AppState) {
    // Subscribe first so a change made while building the snapshot stays queued.
    let rx = app_state.provider_updates.subscribe();
    let event = app_state.provider_updates.snapshot().into_event(None);
    let payload = serde_json::to_value(event).unwrap_or_else(|_| serde_json::json!({}));
    let update = WsEnvelope::new("app", "provider_updates", payload);
    let _ = sender.send(Message::Text(String::from(update).into()));
    forward_app_events(sender, rx, "provider_updates", OnLag::Skip);
}

/// Which agents the last restart interrupted and what this start did about
/// them: sent on subscribe while the report is fresh, then when the startup
/// pass publishes it (a client usually connects before the pass finishes).
pub(super) fn subscribe_restart_continuation_events(sender: &WsSender) {
    use crate::domain::restart_continuations::{fresh_report, subscribe_reports};
    let mut rx = subscribe_reports();
    let initial = fresh_report(&rx.borrow_and_update());
    if let Some(report) = initial {
        send_restart_continuations(sender, &report);
    }
    let sender = sender.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = sender.closed() => break,
                changed = rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let report = fresh_report(&rx.borrow_and_update());
                    if let Some(report) = report {
                        if !send_restart_continuations(&sender, &report) {
                            break;
                        }
                    }
                }
            }
        }
    });
}

fn send_restart_continuations(
    sender: &WsSender,
    report: &crate::domain::restart_continuations::RestartContinuationReport,
) -> bool {
    let payload = serde_json::to_value(report).unwrap_or_else(|_| serde_json::json!({}));
    let update = WsEnvelope::new("app", "restart_continuations", payload);
    sender
        .send(Message::Text(String::from(update).into()))
        .is_ok()
}
