//! The gates a session closed lately, so a turn end that read one as still
//! pending before it closed cannot show it again.

use std::collections::{HashMap, VecDeque};

/// Closed request ids kept per session. Ids are unique per gate and a stale
/// turn end trails its close by moments, so a few recent ones suffice.
const KEPT_PER_SESSION: usize = 8;
/// How long a close is remembered; older ones are dropped at the next close.
const KEPT_FOR_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Default)]
pub(super) struct ClosedGates {
    by_session: HashMap<i64, VecDeque<(String, i64)>>,
}

impl ClosedGates {
    pub(super) fn record(&mut self, session_id: i64, request_id: &str, now_ms: i64) {
        // Closes are rare (one per answered or closed gate): prune every
        // session here so sessions never seen again do not stay forever.
        self.by_session.retain(|_, closed| {
            closed.retain(|(_, closed_at)| now_ms - closed_at < KEPT_FOR_MS);
            !closed.is_empty()
        });
        let closed = self.by_session.entry(session_id).or_default();
        if closed.iter().any(|(id, _)| id == request_id) {
            return;
        }
        if closed.len() == KEPT_PER_SESSION {
            closed.pop_front();
        }
        closed.push_back((request_id.to_string(), now_ms));
    }

    /// A gate raised (again) under `request_id` is open.
    pub(super) fn reopen(&mut self, session_id: i64, request_id: &str) {
        if let Some(closed) = self.by_session.get_mut(&session_id) {
            closed.retain(|(id, _)| id != request_id);
            if closed.is_empty() {
                self.by_session.remove(&session_id);
            }
        }
    }

    pub(super) fn contains(&self, session_id: i64, request_id: &str) -> bool {
        self.by_session
            .get(&session_id)
            .is_some_and(|closed| closed.iter().any(|(id, _)| id == request_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_latest_closes_per_session_and_forgets_a_reopened_gate() {
        let mut gates = ClosedGates::default();
        for index in 0..=KEPT_PER_SESSION {
            gates.record(1, &format!("q-{index}"), 0);
        }
        assert!(!gates.contains(1, "q-0"), "the oldest is dropped");
        assert!(gates.contains(1, &format!("q-{KEPT_PER_SESSION}")));
        assert!(!gates.contains(2, "q-1"), "per session");

        gates.reopen(1, "q-1");
        assert!(!gates.contains(1, "q-1"));
    }

    #[test]
    fn old_closes_of_every_session_are_dropped_at_the_next_close() {
        let mut gates = ClosedGates::default();
        gates.record(1, "q-old", 0);

        gates.record(2, "q-new", KEPT_FOR_MS);

        assert!(!gates.contains(1, "q-old"));
        assert!(!gates.by_session.contains_key(&1), "the session is gone");
        assert!(gates.contains(2, "q-new"));
    }
}
