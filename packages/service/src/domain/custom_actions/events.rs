//! Push notifications for custom actions.
//!
//! Actions are edited and runs progress over plain HTTP and in detached
//! background tasks (a schedule, another device), so without a push the header
//! status and the run output only caught up on their next poll. Every change is
//! broadcast as a bare hint on `custom_action_events_tx`; clients re-fetch the
//! queries it names. No `seq`/snapshot: a lagged client gets an empty payload
//! and re-fetches everything.

use serde::Serialize;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomActionEventKind {
    /// An action was created, edited, reordered or deleted.
    Changed,
    /// A run row was created and its command started.
    RunStarted,
    /// A running command's captured output was persisted.
    RunOutput,
    /// A run finished, failed to start, or was cancelled.
    RunFinished,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomActionEvent {
    pub kind: CustomActionEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feature_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<i64>,
}

pub type CustomActionEventSender = broadcast::Sender<CustomActionEvent>;

/// Notify clients that the action list changed.
pub fn notify_changed(tx: &CustomActionEventSender, action_id: Option<i64>) {
    // No subscriber is fine: no client is connected.
    let _ = tx.send(CustomActionEvent {
        kind: CustomActionEventKind::Changed,
        action_id,
        feature_id: None,
        run_id: None,
    });
}

/// Notify clients that a run of `action_id` in `feature_id` progressed.
pub fn notify_run(
    tx: &CustomActionEventSender,
    kind: CustomActionEventKind,
    action_id: i64,
    feature_id: i64,
    run_id: i64,
) {
    let _ = tx.send(CustomActionEvent {
        kind,
        action_id: Some(action_id),
        feature_id: Some(feature_id),
        run_id: Some(run_id),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_event_serializes_as_a_snake_case_hint() {
        let (tx, mut rx) = broadcast::channel(4);
        notify_run(&tx, CustomActionEventKind::RunFinished, 3, 7, 11);
        let event = rx.try_recv().unwrap();
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({"kind": "run_finished", "action_id": 3, "feature_id": 7, "run_id": 11})
        );
    }

    #[test]
    fn changed_event_omits_run_fields() {
        let (tx, mut rx) = broadcast::channel(4);
        notify_changed(&tx, None);
        let event = rx.try_recv().unwrap();
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({"kind": "changed"})
        );
    }
}
