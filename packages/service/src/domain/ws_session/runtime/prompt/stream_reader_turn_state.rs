#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::domain::ws_session) struct StreamTurnState {
    phase: TurnPhase,
    surfaced_error_this_turn: bool,
    started_at: std::time::Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnPhase {
    AwaitingFirstEvent,
    Active,
    BetweenTurnsAfterResult,
}

impl StreamTurnState {
    pub(in crate::domain::ws_session) fn new() -> Self {
        Self {
            phase: TurnPhase::AwaitingFirstEvent,
            surfaced_error_this_turn: false,
            started_at: std::time::Instant::now(),
        }
    }

    pub(in crate::domain::ws_session) fn is_between_turns(&self) -> bool {
        matches!(
            self.phase,
            TurnPhase::AwaitingFirstEvent | TurnPhase::BetweenTurnsAfterResult
        )
    }

    pub(in crate::domain::ws_session) fn has_completed_turn(&self) -> bool {
        matches!(self.phase, TurnPhase::BetweenTurnsAfterResult)
    }

    pub(in crate::domain::ws_session) fn has_error_surfaced_this_turn(&self) -> bool {
        self.surfaced_error_this_turn
    }

    pub(in crate::domain::ws_session) fn mark_error_surfaced(
        &mut self,
        parent_tool_use_id: Option<&str>,
    ) {
        // A descendant failure must not suppress a distinct root failure.
        self.surfaced_error_this_turn |= parent_tool_use_id.is_none();
    }

    pub(in crate::domain::ws_session) fn mark_fresh_turn_started(&mut self) {
        if self.is_between_turns() {
            self.started_at = std::time::Instant::now();
        }
        self.phase = TurnPhase::Active;
        self.surfaced_error_this_turn = false;
    }

    pub(in crate::domain::ws_session) fn elapsed_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub(in crate::domain::ws_session) fn mark_result(&mut self) {
        self.phase = TurnPhase::BetweenTurnsAfterResult;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_waiting_for_the_first_runtime_event_without_completed_turn() {
        let state = StreamTurnState::new();

        assert!(state.is_between_turns());
        assert!(!state.has_completed_turn());
    }

    #[test]
    fn explicit_turn_start_enters_active_and_resets_turn_error() {
        let mut state = StreamTurnState::new();

        state.mark_error_surfaced(None);
        state.mark_fresh_turn_started();

        assert!(!state.is_between_turns());
        assert!(!state.has_error_surfaced_this_turn());
    }

    #[test]
    fn result_moves_to_between_turns_and_records_completed_turn() {
        let mut state = StreamTurnState::new();

        state.mark_fresh_turn_started();
        state.mark_result();

        assert!(state.is_between_turns());
        assert!(state.has_completed_turn());
    }

    #[test]
    fn child_errors_do_not_suppress_root_errors_or_clear_root_deduplication() {
        let mut state = StreamTurnState::new();
        state.mark_fresh_turn_started();
        state.mark_error_surfaced(Some("spawn-child"));
        assert!(!state.has_error_surfaced_this_turn());
        state.mark_error_surfaced(None);
        assert!(state.has_error_surfaced_this_turn());
        state.mark_error_surfaced(Some("spawn-other"));
        assert!(state.has_error_surfaced_this_turn());
    }
}
