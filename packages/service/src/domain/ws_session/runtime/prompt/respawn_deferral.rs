//! Why a setting change that needs a respawn waits instead of applying now.
//!
//! Respawning closes the runtime. While the runtime still owes the agent work
//! (a running turn, a pending question, a background task or wake-up), the
//! close would cut that work off, so the change is recorded and applied by the
//! first prompt that finds the runtime free.

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSessionHandle;

use super::super::{send_error, WsSender};
use super::runtime_hold_registry::runtime_is_held;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::domain::ws_session) enum RespawnDeferral {
    /// The runtime owes the agent a resume: a background task or a wake-up.
    BackgroundWork,
    /// A turn is running or waits on the user.
    LiveTurn,
}

/// Whether respawning `runtime` now would cut off work, and which.
pub(in crate::domain::ws_session) fn respawn_deferral(
    app_state: &AppState,
    db_session_id: i64,
    runtime: &RuntimeSessionHandle,
) -> Option<RespawnDeferral> {
    if runtime_is_held(db_session_id, runtime) {
        Some(RespawnDeferral::BackgroundWork)
    } else if app_state.session_status_tx.is_busy(db_session_id) {
        Some(RespawnDeferral::LiveTurn)
    } else {
        None
    }
}

/// Tell the sender that its `changes` (user-facing labels) wait: applying them
/// now would respawn the runtime and cut off its work.
pub(in crate::domain::ws_session) fn notify_change_deferred(
    sender: &WsSender,
    envelope_id: &str,
    changes: &[&str],
    reason: RespawnDeferral,
) {
    send_error(
        sender,
        envelope_id,
        "RUNTIME_CHANGE_DEFERRED",
        &deferral_notice(changes, reason),
    );
}

fn deferral_notice(changes: &[&str], reason: RespawnDeferral) -> String {
    let waits_on = match reason {
        RespawnDeferral::BackgroundWork => "The agent is waiting on background work",
        RespawnDeferral::LiveTurn => "The agent is working on a turn",
    };
    format!(
        "{waits_on}, so your new {} will apply to your first message after it finishes.",
        changes.join(" and ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::handler::tests::support::{
        make_active_handle, make_test_app_state,
    };

    #[tokio::test]
    async fn a_running_turn_defers_the_respawn() {
        let app_state = make_test_app_state().await;
        let handle = make_active_handle(1, None);
        let runtime = handle.state.active_query().unwrap();
        assert_eq!(respawn_deferral(&app_state, 31, &runtime), None);

        app_state.session_status_tx.broadcast_running(31, 1);

        assert_eq!(
            respawn_deferral(&app_state, 31, &runtime),
            Some(RespawnDeferral::LiveTurn)
        );
    }

    #[test]
    fn the_notice_names_what_the_change_waits_on() {
        assert_eq!(
            deferral_notice(&["reasoning effort"], RespawnDeferral::LiveTurn),
            "The agent is working on a turn, so your new reasoning effort will apply to your first message after it finishes."
        );
        assert_eq!(
            deferral_notice(&["profile", "access mode"], RespawnDeferral::BackgroundWork),
            "The agent is waiting on background work, so your new profile and access mode will apply to your first message after it finishes."
        );
    }
}
