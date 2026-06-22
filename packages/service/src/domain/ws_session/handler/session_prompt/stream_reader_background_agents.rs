//! Tracking which run-in-background agents are still alive for a session.
//!
//! A launched-and-detached agent (Claude Code's `Agent`/`Task` with
//! `run_in_background: true`) outlives the turn that started it. While any is
//! live the session is still "working", so the turn-complete path keeps it
//! `running` instead of going idle (issue #58). Conforms to
//! `.claude/rules/inline-rust-tests.md`.

use std::collections::HashSet;

use crate::domain::agents::adapter::{BackgroundAgentSignal, RuntimeEvent};

/// Maintain the set of live background agents from provider-neutral lifecycle
/// signals. A `Started` agent keeps the session "working" past the launching
/// turn's `Result`; a `Finished` agent releases it (see
/// [`super::stream_reader_task::StreamReaderState::live_background_agents`] and
/// `result_envelope`). An unmatched `Finished` (a sibling task we never tracked)
/// is a harmless no-op remove.
pub(super) fn track_background_agents(live: &mut HashSet<String>, event: &RuntimeEvent) {
    match event.background_agent_signal() {
        Some(BackgroundAgentSignal::Started { agent_id }) => {
            live.insert(agent_id.clone());
        }
        Some(BackgroundAgentSignal::Finished { agent_id }) => {
            live.remove(agent_id);
        }
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::track_background_agents;
    use crate::domain::agents::adapter::{
        BackgroundAgentSignal, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    };
    use std::collections::HashSet;

    fn signal_event(signal: BackgroundAgentSignal) -> RuntimeEvent {
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
            .with_background_agent(Some(signal))
    }

    fn started(agent_id: &str) -> RuntimeEvent {
        signal_event(BackgroundAgentSignal::Started {
            agent_id: agent_id.into(),
        })
    }

    fn finished(agent_id: &str) -> RuntimeEvent {
        signal_event(BackgroundAgentSignal::Finished {
            agent_id: agent_id.into(),
        })
    }

    #[test]
    fn start_then_finish_tracks_and_releases() {
        let mut live = HashSet::new();
        track_background_agents(&mut live, &started("a"));
        assert!(live.contains("a"), "a started agent must be tracked");
        track_background_agents(&mut live, &finished("a"));
        assert!(live.is_empty(), "completion must release the agent");
    }

    #[test]
    fn two_agents_keep_set_nonempty_until_both_finish() {
        let mut live = HashSet::new();
        track_background_agents(&mut live, &started("a"));
        track_background_agents(&mut live, &started("b"));
        track_background_agents(&mut live, &finished("a"));
        assert_eq!(live.len(), 1, "session still working while b runs");
        track_background_agents(&mut live, &finished("b"));
        assert!(live.is_empty());
    }

    #[test]
    fn finish_for_untracked_task_is_noop() {
        // A sibling task's completion (e.g. a nested `local_bash`, which never
        // emits a `Started`) must not disturb tracked agents.
        let mut live = HashSet::from(["a".to_string()]);
        track_background_agents(&mut live, &finished("ghost"));
        assert_eq!(live, HashSet::from(["a".to_string()]));
    }

    #[test]
    fn events_without_a_signal_are_ignored() {
        let mut live = HashSet::new();
        let plain = RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Result);
        track_background_agents(&mut live, &plain);
        assert!(live.is_empty());
    }
}
