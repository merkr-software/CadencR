//! Which interrupted turns the startup pass may resume on its own.

/// At most this many crashes per conversation inside [`LOOP_WINDOW_MINUTES`]
/// are followed by a resume: a turn that crashes the service every time it
/// runs must not be resumed forever. Graceful restarts (updates, `pnpm dev`
/// rebuilds) are no sign of that and do not count.
pub(super) const MAX_RECENT_CRASHES: i64 = 3;
pub(super) const LOOP_WINDOW_MINUTES: i64 = 10;

/// What the guards know about one captured turn.
#[derive(Debug, Clone, Copy)]
pub(super) struct Candidate {
    pub stop_requested: bool,
    pub enabled: bool,
    pub feature_archived: bool,
    pub has_resume_id: bool,
    /// Crash captures of this conversation inside the window, this one included.
    pub recent_crashes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SkipReason {
    /// Something already started a new turn in this conversation.
    AlreadyRunning,
    /// The turn finished on its own after it was captured, while the service
    /// was still shutting down.
    Finished,
    /// The user quit Cadencr and chose to stop their agents.
    StoppedOnQuit,
    /// The conversation was archived; nobody is waiting on it.
    Archived,
    /// The user turned automatic resume off.
    Disabled,
    /// The provider never reported a session id, so a prompt would start a
    /// new conversation without its history instead of resuming it.
    NoResumeId,
    /// The conversation was already resumed too often in a short window.
    LoopGuard,
}

impl SkipReason {
    /// Stable code the frontend words for the user.
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::AlreadyRunning => "already_running",
            Self::Finished => "finished",
            Self::StoppedOnQuit => "stopped_on_quit",
            Self::Archived => "archived",
            Self::Disabled => "disabled",
            Self::NoResumeId => "no_resume_id",
            Self::LoopGuard => "loop_guard",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Decision {
    Resume,
    Skip(SkipReason),
}

/// What the conversation did since its turn was captured, from its status
/// read right before the pass touches the transcript: either way the turn is
/// no longer one to mark or resume.
pub(super) fn live_skip(session_status: &str) -> Option<SkipReason> {
    match session_status {
        "running" => Some(SkipReason::AlreadyRunning),
        "completed" => Some(SkipReason::Finished),
        _ => None,
    }
}

/// The guards, in order: what the user asked when quitting wins over their
/// setting. A pending question is no reason to wait: it died with the process
/// that asked it, and the resumed agent asks it again (`gates`).
pub(super) fn decide(candidate: &Candidate) -> Decision {
    let skip = if candidate.stop_requested {
        SkipReason::StoppedOnQuit
    } else if candidate.feature_archived {
        SkipReason::Archived
    } else if !candidate.enabled {
        SkipReason::Disabled
    } else if !candidate.has_resume_id {
        SkipReason::NoResumeId
    } else if candidate.recent_crashes > MAX_RECENT_CRASHES {
        SkipReason::LoopGuard
    } else {
        return Decision::Resume;
    };
    Decision::Skip(skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resumable() -> Candidate {
        Candidate {
            stop_requested: false,
            enabled: true,
            feature_archived: false,
            has_resume_id: true,
            recent_crashes: 0,
        }
    }

    #[test]
    fn an_interrupted_turn_with_a_resume_id_is_resumed() {
        assert_eq!(decide(&resumable()), Decision::Resume);
    }

    #[test]
    fn each_guard_skips_with_its_own_reason() {
        let cases = [
            (
                Candidate {
                    stop_requested: true,
                    ..resumable()
                },
                SkipReason::StoppedOnQuit,
            ),
            (
                Candidate {
                    feature_archived: true,
                    ..resumable()
                },
                SkipReason::Archived,
            ),
            (
                Candidate {
                    enabled: false,
                    ..resumable()
                },
                SkipReason::Disabled,
            ),
            (
                Candidate {
                    has_resume_id: false,
                    ..resumable()
                },
                SkipReason::NoResumeId,
            ),
            (
                Candidate {
                    recent_crashes: MAX_RECENT_CRASHES + 1,
                    ..resumable()
                },
                SkipReason::LoopGuard,
            ),
        ];
        for (candidate, reason) in cases {
            assert_eq!(decide(&candidate), Decision::Skip(reason), "{candidate:?}");
        }
    }

    #[test]
    fn crashes_up_to_the_loop_limit_are_still_resumed() {
        let candidate = Candidate {
            recent_crashes: MAX_RECENT_CRASHES,
            ..resumable()
        };
        assert_eq!(decide(&candidate), Decision::Resume);
    }

    #[test]
    fn a_turn_that_moved_on_since_its_capture_is_left_alone() {
        assert_eq!(live_skip("running"), Some(SkipReason::AlreadyRunning));
        assert_eq!(live_skip("completed"), Some(SkipReason::Finished));
        assert_eq!(live_skip("paused"), None);
    }
}
