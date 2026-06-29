pub(super) fn stream_close_needs_running_status(
    between_turns: bool,
    has_live_background_agents: bool,
    surfaced_error_this_turn: bool,
) -> bool {
    !surfaced_error_this_turn && (!between_turns || !has_live_background_agents)
}

pub(super) fn stream_close_was_unexpected(
    between_turns: bool,
    has_live_background_agents: bool,
    surfaced_error_this_turn: bool,
    session_running: bool,
) -> bool {
    session_running
        && stream_close_needs_running_status(
            between_turns,
            has_live_background_agents,
            surfaced_error_this_turn,
        )
}

#[cfg(test)]
mod tests {
    use super::{stream_close_needs_running_status, stream_close_was_unexpected};

    #[test]
    fn follow_up_turn_that_closes_before_first_provider_event_is_unexpected() {
        // A previous turn may already have produced a Result. The close
        // classifier must depend on current live background state, not a
        // lifetime "saw result" flag, so a new running turn with no live
        // background agent is still unexpected.
        assert!(stream_close_was_unexpected(true, false, false, true));
    }

    #[test]
    fn post_result_running_background_agent_close_is_not_unexpected() {
        assert!(!stream_close_was_unexpected(true, true, false, true));
    }

    #[test]
    fn close_after_surfaceable_provider_error_is_not_reported_twice() {
        assert!(!stream_close_was_unexpected(true, false, true, true));
    }

    #[test]
    fn intentional_or_idle_close_is_not_unexpected() {
        assert!(!stream_close_was_unexpected(false, false, false, false));
    }

    #[test]
    fn close_known_not_unexpected_does_not_need_running_status() {
        assert!(!stream_close_needs_running_status(true, true, false));
        assert!(!stream_close_needs_running_status(true, false, true));
    }
}
