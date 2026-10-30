#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::domain::ws_session) struct StreamTurnState {
    phase: TurnPhase,
    compacting: bool,
    surfaced_error_this_turn: bool,
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
            compacting: false,
            surfaced_error_this_turn: false,
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

    #[cfg(test)]
    fn is_compacting(&self) -> bool {
        self.compacting
    }

    pub(in crate::domain::ws_session) fn set_compacting(&mut self, next: bool) -> bool {
        if self.compacting == next {
            return false;
        }
        self.compacting = next;
        true
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
        self.phase = TurnPhase::Active;
        self.surfaced_error_this_turn = false;
    }

    pub(in crate::domain::ws_session) fn mark_result(&mut self) {
        self.phase = TurnPhase::BetweenTurnsAfterResult;
        self.compacting = false;
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
        assert!(!state.is_compacting());
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
        assert!(!state.is_compacting());
    }

    #[test]
    fn compaction_tracks_only_real_state_changes() {
        let mut state = StreamTurnState::new();

        assert!(state.set_compacting(true));
        assert!(state.is_compacting());
        assert!(!state.set_compacting(true));
        assert!(state.set_compacting(false));
        assert!(!state.is_compacting());
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
