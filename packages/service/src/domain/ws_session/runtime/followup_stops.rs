//! Which follow-ups a user Stop cancels.
//!
//! A follow-up is a prompt sent while a turn runs. When the user stops, every
//! follow-up the agent has not taken in yet is cancelled with the turn: it is
//! never delivered, or the runtime withdraws it, and its message reads as not
//! delivered. One the agent already took in stops with the turn. A prompt sent
//! while nothing runs is no follow-up: the Stop stops the turn it starts.
//!
//! Each session counts its user Stops. A follow-up notes the count when it is
//! accepted and is not handed to the runtime once a later Stop happened. One
//! already handed over is listed until the turn ends, so the next Stop asks
//! the runtime to withdraw it (`AgentRuntimeSession::withdraw_pending_inputs`).

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct SessionFollowups {
    stops: u64,
    /// Client message ids of follow-ups handed to the runtime this turn.
    handed_off: Vec<String>,
}

#[derive(Default)]
pub(crate) struct FollowupStops {
    sessions: Mutex<HashMap<i64, SessionFollowups>>,
}

/// The Stop count a follow-up was accepted under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AcceptedFollowup(u64);

impl FollowupStops {
    fn with<T>(&self, session_id: i64, f: impl FnOnce(&mut SessionFollowups) -> T) -> T {
        let mut sessions = self.sessions.lock().expect("FollowupStops poisoned");
        f(sessions.entry(session_id).or_default())
    }

    /// Note a follow-up accepted while a turn runs.
    pub(crate) fn accept(&self, session_id: i64) -> AcceptedFollowup {
        self.with(session_id, |session| AcceptedFollowup(session.stops))
    }

    /// Whether a user Stop came after `followup` was accepted.
    pub(crate) fn stopped_since(&self, session_id: i64, followup: AcceptedFollowup) -> bool {
        self.with(session_id, |session| session.stops > followup.0)
    }

    /// `client_message_id` reached the runtime; the next Stop withdraws it if
    /// the runtime still holds it.
    pub(crate) fn handed_off(&self, session_id: i64, client_message_id: String) {
        self.with(session_id, |session| {
            session.handed_off.push(client_message_id)
        });
    }

    /// A user Stop: later deliveries of earlier follow-ups are cancelled.
    /// Returns the follow-ups already handed to the runtime, to withdraw.
    pub(crate) fn record_stop(&self, session_id: i64) -> Vec<String> {
        self.with(session_id, |session| {
            session.stops += 1;
            std::mem::take(&mut session.handed_off)
        })
    }

    /// The turn ended: what it was handed was taken in by it or by the turn
    /// the runtime starts for it, which a later Stop stops.
    pub(crate) fn turn_ended(&self, session_id: i64) {
        self.with(session_id, |session| session.handed_off.clear());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_follow_up_is_stopped_only_by_a_later_stop() {
        let stops = FollowupStops::default();
        stops.record_stop(1);
        let followup = stops.accept(1);
        assert!(!stops.stopped_since(1, followup));

        stops.record_stop(1);
        assert!(stops.stopped_since(1, followup));
        assert!(!stops.stopped_since(2, stops.accept(2)), "per session");
    }

    #[test]
    fn a_stop_takes_what_was_handed_off_this_turn() {
        let stops = FollowupStops::default();
        stops.handed_off(1, "a".into());
        stops.turn_ended(1);
        stops.handed_off(1, "b".into());

        assert_eq!(stops.record_stop(1), vec!["b".to_string()]);
        assert!(stops.record_stop(1).is_empty());
    }
}
