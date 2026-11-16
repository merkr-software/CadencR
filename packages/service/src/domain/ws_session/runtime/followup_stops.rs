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
//!
//! One the runtime could not withdraw (a Codex steer already accepted) is
//! settled when the stopped turn ends: taken in if the agent acknowledged it
//! by then, otherwise not delivered. No turn runs it after a Stop, and a
//! receipt that arrives later does not count (see `update_delivery_state`).

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
struct SessionFollowups {
    stops: u64,
    /// Client message ids of follow-ups handed to the runtime this turn.
    handed_off: Vec<String>,
    /// Handed off before a Stop that could not withdraw them: settled when
    /// the stopped turn ends.
    awaiting_stop: Vec<String>,
    /// A Stop came and the turn it stopped has not ended yet.
    stopped_turn_open: bool,
}

/// Where a follow-up handed to the runtime stands.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HandOff {
    /// No Stop since its acceptance: the next Stop withdraws it.
    Listed,
    /// A Stop came while it was on its way (no turn barrier, as on Codex):
    /// the stopped turn's end settles it.
    AwaitsStoppedTurn,
    /// That stopped turn already ended: settle it now. Its receipt, if any,
    /// came before the turn's result.
    SettleNow,
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

    /// `client_message_id`, accepted as `followup`, reached the runtime.
    pub(crate) fn handed_off(
        &self,
        session_id: i64,
        followup: AcceptedFollowup,
        client_message_id: String,
    ) -> HandOff {
        self.with(session_id, |session| {
            if session.stops == followup.0 {
                session.handed_off.push(client_message_id);
                HandOff::Listed
            } else if session.stopped_turn_open {
                session.awaiting_stop.push(client_message_id);
                HandOff::AwaitsStoppedTurn
            } else {
                HandOff::SettleNow
            }
        })
    }

    /// A user Stop: later deliveries of earlier follow-ups are cancelled.
    /// Returns the follow-ups already handed to the runtime, to withdraw.
    pub(crate) fn record_stop(&self, session_id: i64) -> Vec<String> {
        self.with(session_id, |session| {
            session.stops += 1;
            session.stopped_turn_open = true;
            std::mem::take(&mut session.handed_off)
        })
    }

    /// Follow-ups a Stop could not withdraw: the stopped turn's end settles
    /// them.
    pub(crate) fn await_stopped_turn(&self, session_id: i64, client_message_ids: Vec<String>) {
        self.with(session_id, |session| {
            session.awaiting_stop.extend(client_message_ids)
        });
    }

    /// A stopped turn ended after a newer turn began: settle what its Stop
    /// could not withdraw, leaving the newer turn's follow-ups listed.
    pub(crate) fn stopped_turn_ended(&self, session_id: i64) -> Vec<String> {
        self.with(session_id, |session| {
            session.stopped_turn_open = false;
            std::mem::take(&mut session.awaiting_stop)
        })
    }

    /// The turn ended: what it was handed was taken in by it or by the turn
    /// the runtime starts for it, which a later Stop stops. Returns the
    /// follow-ups a Stop could not withdraw, for a stopped turn to settle.
    pub(crate) fn turn_ended(&self, session_id: i64) -> Vec<String> {
        self.with(session_id, |session| {
            session.handed_off.clear();
            session.stopped_turn_open = false;
            std::mem::take(&mut session.awaiting_stop)
        })
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
        stops.handed_off(1, stops.accept(1), "a".into());
        assert!(stops.turn_ended(1).is_empty());
        stops.handed_off(1, stops.accept(1), "b".into());

        assert_eq!(stops.record_stop(1), vec!["b".to_string()]);
        assert!(stops.record_stop(1).is_empty());
    }

    #[test]
    fn what_a_stop_could_not_withdraw_waits_for_the_stopped_turn() {
        let stops = FollowupStops::default();
        stops.handed_off(1, stops.accept(1), "steer".into());
        let handed_off = stops.record_stop(1);
        stops.await_stopped_turn(1, handed_off);

        assert_eq!(stops.turn_ended(1), vec!["steer".to_string()]);
        assert!(stops.turn_ended(1).is_empty(), "settled once");
    }

    /// Found live on Codex (no turn barrier): the Stop came between the
    /// follow-up's last check and its hand-over, so it was never settled.
    #[test]
    fn a_follow_up_handed_over_after_a_stop_is_still_settled() {
        let stops = FollowupStops::default();
        let followup = stops.accept(1);
        stops.record_stop(1);

        assert_eq!(
            stops.handed_off(1, followup, "late".into()),
            HandOff::AwaitsStoppedTurn
        );
        assert_eq!(stops.turn_ended(1), vec!["late".to_string()]);

        let followup = stops.accept(1);
        stops.record_stop(1);
        stops.turn_ended(1);
        assert_eq!(
            stops.handed_off(1, followup, "later".into()),
            HandOff::SettleNow
        );
    }
}
