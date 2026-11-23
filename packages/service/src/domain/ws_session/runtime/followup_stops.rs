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
//!
//! A prompt sent while nothing runs reserves its turn first: the session reads
//! as working while its pre-turn checkpoint runs, before the runtime has it. A
//! Stop in that window cancels the reserved start instead of interrupting a
//! runtime that runs nothing, and the prompt is withdrawn like a follow-up.
//! The reservation names the logical turn it began: once another turn began
//! (a follow-up handed over, a new runtime), it no longer means that nothing
//! runs, and a Stop interrupts the runtime as for any running turn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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
    /// The prompt sent while idle that reserved its turn and has not reached
    /// the runtime yet. Later prompts follow it, so there is at most one.
    pending_start: Option<PendingStart>,
}

#[derive(Clone, Copy)]
struct PendingStart {
    id: u64,
    /// The logical turn its reservation began, once known.
    generation: Option<u64>,
}

impl PendingStart {
    /// Whether no turn began since this reservation: the runtime runs nothing.
    fn is_current(&self, current_generation: Option<u64>) -> bool {
        self.generation.is_none() || self.generation == current_generation
    }
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
    next_start: AtomicU64,
}

/// The Stop count a follow-up was accepted under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AcceptedFollowup(u64);

/// A prompt sent while idle that reserved its turn before reaching the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReservedStart(u64);

/// How a prompt that found the session idle when it arrived goes on.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IdleArrival {
    /// A turn started meanwhile: the prompt follows it, as a follow-up.
    Follows(AcceptedFollowup),
    /// The prompt starts the turn, reserved now.
    Starts(ReservedStart),
}

/// What a user Stop found.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RecordedStop {
    /// Follow-ups already handed to the runtime, to withdraw.
    pub(crate) handed_off: Vec<String>,
    /// A reserved start was cancelled before it reached the runtime: no turn
    /// runs, and the Stop ends the one reserved.
    pub(crate) cancelled_start: bool,
}

impl FollowupStops {
    fn with<T>(&self, session_id: i64, f: impl FnOnce(&mut SessionFollowups) -> T) -> T {
        let mut sessions = self.sessions.lock().expect("FollowupStops poisoned");
        f(sessions.entry(session_id).or_default())
    }

    /// Note a follow-up accepted while a turn runs.
    pub(crate) fn accept(&self, session_id: i64) -> AcceptedFollowup {
        self.with(session_id, |session| AcceptedFollowup(session.stops))
    }

    /// A prompt that found the session idle, once persisted. `busy`: whether a
    /// turn runs now. One that started meanwhile, or a start still reserved,
    /// makes it a follow-up of that turn; otherwise it reserves its own start.
    pub(crate) fn arrive_idle(&self, session_id: i64, busy: bool) -> IdleArrival {
        self.with(session_id, |session| {
            if busy || session.pending_start.is_some() {
                return IdleArrival::Follows(AcceptedFollowup(session.stops));
            }
            let id = self.next_start.fetch_add(1, Ordering::Relaxed);
            session.pending_start = Some(PendingStart {
                id,
                generation: None,
            });
            IdleArrival::Starts(ReservedStart(id))
        })
    }

    /// The logical turn `start`'s reservation began.
    pub(crate) fn set_start_generation(
        &self,
        session_id: i64,
        start: ReservedStart,
        generation: Option<u64>,
    ) {
        self.with(session_id, |session| {
            if let Some(pending) = session.pending_start.as_mut().filter(|p| p.id == start.0) {
                pending.generation = generation;
            }
        })
    }

    /// Whether `start` still waits to reach the runtime (no Stop cancelled it).
    pub(crate) fn start_pending(&self, session_id: i64, start: ReservedStart) -> bool {
        self.with(session_id, |session| {
            session
                .pending_start
                .is_some_and(|pending| pending.id == start.0)
        })
    }

    /// Take `start` back from the reserved ones: `true` while it was still
    /// reserved, so its prompt alone settles the turn. `false` once a Stop or a
    /// sleep pause cancelled it and ended that turn.
    pub(crate) fn take_start(&self, session_id: i64, start: ReservedStart) -> bool {
        self.with(session_id, |session| {
            let taken = session
                .pending_start
                .is_some_and(|pending| pending.id == start.0);
            if taken {
                session.pending_start = None;
            }
            taken
        })
    }

    /// Cancel a reserved start (the machine sleeps): it counts as stopped,
    /// with the follow-ups waiting behind it. Returns whether it was the
    /// current turn's (nothing runs then); a stale one leaves a running turn
    /// to interrupt.
    pub(crate) fn cancel_pending_start(
        &self,
        session_id: i64,
        current_generation: Option<u64>,
    ) -> bool {
        self.with(session_id, |session| {
            let Some(pending) = session.pending_start.take() else {
                return false;
            };
            session.stops += 1;
            pending.is_current(current_generation)
        })
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

    /// A user Stop: later deliveries of earlier follow-ups are cancelled, and
    /// so is a reserved start. One reserved for the current turn
    /// (`current_generation`) leaves no turn running, so no stopped turn will
    /// end.
    pub(crate) fn record_stop(
        &self,
        session_id: i64,
        current_generation: Option<u64>,
    ) -> RecordedStop {
        self.with(session_id, |session| {
            session.stops += 1;
            let cancelled_start = session
                .pending_start
                .take()
                .is_some_and(|pending| pending.is_current(current_generation));
            if !cancelled_start {
                session.stopped_turn_open = true;
            }
            RecordedStop {
                handed_off: std::mem::take(&mut session.handed_off),
                cancelled_start,
            }
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
        stops.record_stop(1, None);
        let followup = stops.accept(1);
        assert!(!stops.stopped_since(1, followup));

        stops.record_stop(1, None);
        assert!(stops.stopped_since(1, followup));
        assert!(!stops.stopped_since(2, stops.accept(2)), "per session");
    }

    #[test]
    fn a_stop_takes_what_was_handed_off_this_turn() {
        let stops = FollowupStops::default();
        stops.handed_off(1, stops.accept(1), "a".into());
        assert!(stops.turn_ended(1).is_empty());
        stops.handed_off(1, stops.accept(1), "b".into());

        assert_eq!(stops.record_stop(1, None).handed_off, vec!["b".to_string()]);
        assert!(stops.record_stop(1, None).handed_off.is_empty());
    }

    #[test]
    fn what_a_stop_could_not_withdraw_waits_for_the_stopped_turn() {
        let stops = FollowupStops::default();
        stops.handed_off(1, stops.accept(1), "steer".into());
        let handed_off = stops.record_stop(1, None).handed_off;
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
        stops.record_stop(1, None);

        assert_eq!(
            stops.handed_off(1, followup, "late".into()),
            HandOff::AwaitsStoppedTurn
        );
        assert_eq!(stops.turn_ended(1), vec!["late".to_string()]);

        let followup = stops.accept(1);
        stops.record_stop(1, None);
        stops.turn_ended(1);
        assert_eq!(
            stops.handed_off(1, followup, "later".into()),
            HandOff::SettleNow
        );
    }

    fn reserve(stops: &FollowupStops, session_id: i64) -> ReservedStart {
        match stops.arrive_idle(session_id, false) {
            IdleArrival::Starts(start) => start,
            IdleArrival::Follows(_) => panic!("an idle session reserves the start"),
        }
    }

    #[test]
    fn a_stop_cancels_a_reserved_start_without_a_stopped_turn() {
        let stops = FollowupStops::default();
        let start = reserve(&stops, 1);
        let behind = stops.accept(1);
        assert!(stops.start_pending(1, start));

        let stop = stops.record_stop(1, None);
        assert!(stop.cancelled_start);
        assert!(!stops.start_pending(1, start));
        assert!(!stops.take_start(1, start), "the Stop settles its turn");
        assert_eq!(
            stops.handed_off(1, behind, "behind".into()),
            HandOff::SettleNow,
            "no stopped turn will end to settle it"
        );
    }

    #[test]
    fn a_prompt_behind_a_reserved_start_follows_it() {
        let stops = FollowupStops::default();
        let start = reserve(&stops, 1);
        let IdleArrival::Follows(behind) = stops.arrive_idle(1, false) else {
            panic!("a reserved start makes the next prompt its follow-up");
        };
        assert!(matches!(
            stops.arrive_idle(2, true),
            IdleArrival::Follows(_)
        ));

        stops.record_stop(1, None);
        assert!(stops.stopped_since(1, behind), "one Stop cancels both");
        assert!(!stops.take_start(1, start));
    }

    #[test]
    fn a_start_taken_before_the_stop_is_its_own() {
        let stops = FollowupStops::default();
        let start = reserve(&stops, 1);
        assert!(stops.take_start(1, start));
        assert!(!stops.record_stop(1, None).cancelled_start, "its turn runs");
        assert!(matches!(
            stops.arrive_idle(1, false),
            IdleArrival::Starts(_)
        ));
    }

    #[test]
    fn a_sleep_pause_cancels_only_reserved_starts() {
        let stops = FollowupStops::default();
        assert!(!stops.cancel_pending_start(1, None));
        let followup = stops.accept(1);
        assert!(!stops.stopped_since(1, followup), "nothing was cancelled");

        let start = reserve(&stops, 1);
        assert!(stops.cancel_pending_start(1, None));
        assert!(!stops.start_pending(1, start));
        assert!(stops.stopped_since(1, followup));
    }

    /// Found in review: a follow-up handed over after an idle prompt reserved
    /// its turn starts a turn of its own. The reservation no longer means that
    /// nothing runs: the Stop must interrupt that turn.
    #[test]
    fn a_reservation_another_turn_overtook_does_not_hide_that_turn() {
        let stops = FollowupStops::default();
        let start = reserve(&stops, 1);
        stops.set_start_generation(1, start, Some(4));

        let stop = stops.record_stop(1, Some(5));
        assert!(!stop.cancelled_start, "turn 5 runs and must be interrupted");
        assert!(
            !stops.start_pending(1, start),
            "the stale start is cancelled too"
        );

        let start = reserve(&stops, 1);
        stops.set_start_generation(1, start, Some(6));
        assert!(!stops.cancel_pending_start(1, Some(7)));
        assert!(!stops.start_pending(1, start));
        let start = reserve(&stops, 1);
        stops.set_start_generation(1, start, Some(8));
        assert!(stops.record_stop(1, Some(8)).cancelled_start);
    }
}
