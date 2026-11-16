//! A turn's clock: when it started, how long it waited on its user, and the
//! models the CLI reported running it.
//!
//! The live status book owns one per busy session and moves it on status
//! transitions only: a gate opening starts the wait, the gate answered ends it,
//! the turn going idle closes the clock into a [`CompletedTurn`]. Elapsed time
//! is never stored — every device derives it from these instants, so all of
//! them show the same timer without the server ticking.

use serde::Serialize;

/// The running turn's clock, flattened into every status event and snapshot
/// entry. Instants are server wall-clock epoch milliseconds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TurnClock {
    /// When the turn started. `None` only for a gate persisted before turns
    /// had a clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_started_at_ms: Option<i64>,
    /// Time already spent waiting on the user, gates answered so far.
    pub waiting_ms: i64,
    /// When the open gate opened; `None` while the agent works.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_since_ms: Option<i64>,
    /// The model the CLI last reported running the turn's root agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Every model reported during the turn, in order, repeats collapsed.
    #[serde(skip)]
    pub models: Vec<String>,
    /// Whether the turn's end is recorded in the transcript. A user shell run
    /// keeps the session busy but is not an agent turn.
    #[serde(skip)]
    pub summarized: bool,
}

impl TurnClock {
    pub fn start(now_ms: i64, summarized: bool) -> Self {
        Self {
            turn_started_at_ms: Some(now_ms),
            summarized,
            ..Self::default()
        }
    }

    /// A clock restored from the database at boot.
    pub fn restored(
        turn_started_at_ms: Option<i64>,
        waiting_ms: i64,
        waiting_since_ms: Option<i64>,
        models: Vec<String>,
    ) -> Self {
        Self {
            turn_started_at_ms,
            waiting_ms: waiting_ms.max(0),
            waiting_since_ms,
            model: models.last().cloned(),
            models,
            summarized: true,
        }
    }

    pub(super) fn open_gate(&mut self, now_ms: i64) {
        self.waiting_since_ms.get_or_insert(now_ms);
    }

    pub(super) fn close_gate(&mut self, now_ms: i64) {
        if let Some(since) = self.waiting_since_ms.take() {
            self.waiting_ms += (now_ms - since).max(0);
        }
    }

    /// Record the model the CLI reports running the root agent. `true` when it
    /// differs from the last one reported.
    pub(super) fn observe_model(&mut self, model: &str) -> bool {
        if self.model.as_deref() == Some(model) {
            return false;
        }
        self.model = Some(model.to_string());
        if self.models.last().map(String::as_str) != Some(model) {
            self.models.push(model.to_string());
        }
        true
    }

    /// Close the clock at `now_ms`. `None` for a turn whose end the transcript
    /// does not record, or whose start is unknown.
    pub(super) fn finish(
        mut self,
        session_id: i64,
        feature_id: i64,
        now_ms: i64,
    ) -> Option<CompletedTurn> {
        let started_at_ms = self.turn_started_at_ms.filter(|_| self.summarized)?;
        self.close_gate(now_ms);
        Some(CompletedTurn {
            session_id,
            feature_id,
            started_at_ms,
            ended_at_ms: now_ms.max(started_at_ms),
            waiting_ms: self.waiting_ms,
            models: self.models,
        })
    }
}

/// A finished turn, as its closing transcript line reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletedTurn {
    pub session_id: i64,
    pub feature_id: i64,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub waiting_ms: i64,
    pub models: Vec<String>,
}

/// The `turn_summary` row content: the breakdown the client renders as
/// "Worked - <model> - <total> - Waiting <w> - Agent <a>".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnSummaryContent<'a> {
    started_at_ms: i64,
    ended_at_ms: i64,
    total_ms: i64,
    waiting_ms: i64,
    agent_ms: i64,
    models: &'a [String],
}

impl CompletedTurn {
    pub fn total_ms(&self) -> i64 {
        self.ended_at_ms - self.started_at_ms
    }

    pub fn summary_content(&self) -> String {
        let total_ms = self.total_ms();
        let waiting_ms = self.waiting_ms.clamp(0, total_ms);
        serde_json::to_string(&TurnSummaryContent {
            started_at_ms: self.started_at_ms,
            ended_at_ms: self.ended_at_ms,
            total_ms,
            waiting_ms,
            agent_ms: total_ms - waiting_ms,
            models: &self.models,
        })
        .expect("turn summary serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_accumulates_across_gates_and_an_open_gate_closes_at_the_end() {
        let mut clock = TurnClock::start(1_000, true);
        clock.open_gate(2_000);
        clock.open_gate(2_500);
        clock.close_gate(3_000);
        clock.close_gate(3_500);
        assert_eq!(clock.waiting_ms, 1_000);
        clock.open_gate(9_000);

        let turn = clock.finish(7, 8, 10_000).unwrap();
        assert_eq!(turn.waiting_ms, 2_000);
        assert_eq!(turn.total_ms(), 9_000);
    }

    #[test]
    fn models_collapse_repeats_but_keep_a_switch_back() {
        let mut clock = TurnClock::start(0, true);
        assert!(clock.observe_model("opus"));
        assert!(!clock.observe_model("opus"));
        assert!(clock.observe_model("sonnet"));
        assert!(clock.observe_model("opus"));
        assert_eq!(clock.models, ["opus", "sonnet", "opus"]);
        assert_eq!(clock.model.as_deref(), Some("opus"));
    }

    #[test]
    fn unsummarized_or_unstarted_turns_record_nothing() {
        assert!(TurnClock::start(0, false).finish(1, 2, 5).is_none());
        assert!(TurnClock::restored(None, 0, None, Vec::new())
            .finish(1, 2, 5)
            .is_none());
    }

    #[test]
    fn summary_content_splits_total_into_waiting_and_agent_time() {
        let mut clock = TurnClock::start(1_000, true);
        clock.observe_model("gpt-5.5");
        clock.open_gate(2_000);
        clock.close_gate(5_000);
        let content: serde_json::Value =
            serde_json::from_str(&clock.finish(1, 2, 11_000).unwrap().summary_content()).unwrap();
        assert_eq!(content["totalMs"], 10_000);
        assert_eq!(content["waitingMs"], 3_000);
        assert_eq!(content["agentMs"], 7_000);
        assert_eq!(content["models"], serde_json::json!(["gpt-5.5"]));
    }

    #[test]
    fn the_wire_shape_omits_what_a_device_cannot_use() {
        let mut clock = TurnClock::start(1_000, true);
        clock.observe_model("opus");
        let wire = serde_json::to_value(&clock).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "turn_started_at_ms": 1_000, "waiting_ms": 0, "model": "opus" })
        );
    }
}
