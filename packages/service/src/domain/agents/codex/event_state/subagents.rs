//! Root identity and verified spawn routes outlive per-turn content caches.
use super::{IndexState, PendingSpawnRoute};

impl IndexState {
    pub(in crate::domain::agents::codex) fn should_recover_subagent(
        &mut self,
        thread: &str,
    ) -> bool {
        !thread.is_empty()
            && !self.is_session_thread(thread)
            && self.subagent_recovery_attempts.insert(thread.to_string())
    }

    pub(in crate::domain::agents::codex) fn is_root_thread(&self, thread: &str) -> bool {
        self.root_thread_id.as_deref() == Some(thread)
    }

    pub(in crate::domain::agents::codex) fn is_session_thread(&self, thread: &str) -> bool {
        self.is_root_thread(thread) || self.subagent_parent_tool_use_id(thread).is_some()
    }

    pub(in crate::domain::agents::codex) fn is_untracked_thread(&self, thread: &str) -> bool {
        self.root_thread_id.is_some() && !self.is_session_thread(thread)
    }

    pub(in crate::domain::agents::codex) fn seed_known_subagents(
        &mut self,
        known: Vec<crate::domain::agents::adapter::KnownSubagent>,
    ) {
        self.known_subagent_carriers.extend(
            known
                .into_iter()
                .map(|run| (run.child_session_id, run.tool_use_id)),
        );
    }

    /// The carrier an earlier runtime recorded for `thread`, used once.
    pub(in crate::domain::agents::codex) fn take_known_carrier(
        &mut self,
        thread: &str,
    ) -> Option<String> {
        self.known_subagent_carriers.remove(thread)
    }

    /// Record that `subagent_thread_id` belongs to a sub-agent spawned by the
    /// `spawn_agent` collab tool call with id `parent_tool_use_id`.
    pub(in crate::domain::agents::codex) fn record_subagent_thread(
        &mut self,
        subagent_thread_id: &str,
        parent_tool_use_id: &str,
    ) -> bool {
        if self.is_root_thread(subagent_thread_id) || subagent_thread_id.is_empty() {
            return false;
        }
        self.subagent_threads.insert(
            subagent_thread_id.to_string(),
            parent_tool_use_id.to_string(),
        );
        self.pending_spawn_routes.remove(parent_tool_use_id);
        true
    }

    /// Returns the `tool_use_id` of the parent `spawn_agent` call if
    /// `thread_id` is a tracked sub-agent thread.
    pub(in crate::domain::agents::codex) fn subagent_parent_tool_use_id(
        &self,
        thread_id: &str,
    ) -> Option<&str> {
        if self.is_root_thread(thread_id) {
            return None;
        }
        self.subagent_threads.get(thread_id).map(String::as_str)
    }

    /// Cheap predicate to short-circuit per-notification post-processing on
    /// turns that never touched a sub-agent. The codex stream multiplexes
    /// every thread; without this, every event would pay for a HashMap
    /// lookup + a `thread_id.to_string()` even when no spawn ever happened.
    pub(in crate::domain::agents::codex) fn has_any_subagents(&self) -> bool {
        !self.subagent_threads.is_empty()
    }

    /// Mark `call_id` as a `spawn_agent` invocation pending its
    /// `function_call_output` (where the spawned threadId is reported).
    pub(in crate::domain::agents::codex) fn record_pending_spawn_call(
        &mut self,
        call_id: &str,
        sender_thread_id: &str,
        task_name: Option<&str>,
    ) {
        self.pending_spawn_calls.insert(call_id.to_string());
        self.pending_spawn_routes.insert(
            call_id.to_string(),
            PendingSpawnRoute {
                sender_thread_id: sender_thread_id.to_string(),
                task_name: task_name.map(ToOwned::to_owned),
            },
        );
    }

    /// Take the pending flag for `call_id`. Returns true if this call_id was
    /// previously recorded via `record_pending_spawn_call`. Removes the entry
    /// so a duplicate output can't double-register the same thread.
    pub(in crate::domain::agents::codex) fn take_pending_spawn_call(
        &mut self,
        call_id: &str,
    ) -> bool {
        self.pending_spawn_calls.remove(call_id)
    }

    pub(in crate::domain::agents::codex) fn discard_pending_spawn_route(&mut self, call_id: &str) {
        self.pending_spawn_routes.remove(call_id);
    }

    /// Match a child route by parent thread and the task-name segment of its
    /// `agent_path`.
    pub(in crate::domain::agents::codex) fn take_pending_spawn_route(
        &mut self,
        sender_thread_id: &str,
        agent_path: Option<&str>,
    ) -> Option<String> {
        let mut matching = self
            .pending_spawn_routes
            .iter()
            .filter(|(_, route)| route.sender_thread_id == sender_thread_id)
            .filter(|(_, route)| route_matches_agent_path(route, agent_path))
            .map(|(call_id, _)| call_id.clone());
        let call_id = matching.next()?;
        if matching.next().is_some() {
            return None;
        }
        self.pending_spawn_routes.remove(&call_id);
        Some(call_id)
    }

    /// Decide whether a `turn/started` for `thread_id` should reset the
    /// per-turn caches. The first thread we ever see is the root; thereafter
    /// only the root's turn boundaries reset state. Sub-agent turn/starteds
    /// are no-ops at the root's bookkeeping level.
    pub(in crate::domain::agents::codex) fn should_reset_for_turn_started(
        &mut self,
        thread_id: &str,
    ) -> bool {
        match self.root_thread_id.as_deref() {
            None => {
                self.root_thread_id = Some(thread_id.to_string());
                true
            }
            Some(root) => root == thread_id,
        }
    }
}

fn route_matches_agent_path(route: &PendingSpawnRoute, agent_path: Option<&str>) -> bool {
    let Some(agent_path) = agent_path else {
        return route.task_name.is_none();
    };
    let Some(task_name) = route.task_name.as_deref() else {
        return true;
    };
    let normalized_task = task_name.trim_matches('/');
    let normalized_path = agent_path.trim_matches('/');
    normalized_path == normalized_task
        || normalized_path
            .rsplit('/')
            .next()
            .is_some_and(|segment| segment == normalized_task)
}

#[cfg(test)]
mod tests {
    use super::IndexState;

    #[test]
    fn root_cannot_be_registered_or_read_as_a_child_even_with_a_stale_route() {
        let mut state = IndexState::for_root_thread("root");
        assert!(!state.record_subagent_thread("root", "send-parent"));
        assert!(!state.record_subagent_thread("", "invalid"));
        state.subagent_threads.insert("root".into(), "stale".into());
        assert_eq!(state.subagent_parent_tool_use_id("root"), None);
        state.reset();
        assert_eq!(state.subagent_parent_tool_use_id("root"), None);
        assert!(state.is_session_thread("root"));
        assert!(state.is_untracked_thread("unknown"));
    }

    #[test]
    fn subagent_thread_mapping_round_trips() {
        let mut state = IndexState::default();
        state.record_subagent_thread("thread_child", "toolu_spawn");
        assert_eq!(
            state.subagent_parent_tool_use_id("thread_child"),
            Some("toolu_spawn"),
        );
        assert_eq!(state.subagent_parent_tool_use_id("thread_other"), None);
    }

    #[test]
    fn pending_spawn_route_matches_parent_and_task_path() {
        let mut state = IndexState::default();
        state.record_pending_spawn_call("call_quality", "thread_root", Some("quality_review"));
        state.record_pending_spawn_call("call_other", "thread_root", Some("other_review"));

        assert_eq!(
            state.take_pending_spawn_route("thread_root", Some("/root/quality_review")),
            Some("call_quality".to_string()),
        );
        assert_eq!(
            state.take_pending_spawn_route("thread_root", Some("/root/quality_review")),
            None,
        );
    }

    #[test]
    fn first_turn_started_seen_becomes_root_and_resets() {
        let mut state = IndexState::default();
        assert!(state.should_reset_for_turn_started("thread_root"));
        // Subsequent root turn/starteds also reset.
        assert!(state.should_reset_for_turn_started("thread_root"));
        // Sub-agent turn/started must NOT reset — that's what was clobbering
        // the root's index mid-spawn and producing duplicate Agent blocks.
        assert!(!state.should_reset_for_turn_started("thread_subagent"));
    }

    #[test]
    fn record_subagent_message_injected_is_one_shot_per_thread() {
        let mut state = IndexState::default();
        assert!(state.record_subagent_message_injected("thread_child"));
        // Subsequent injections for the same thread are skipped — wait_agent
        // can be polled multiple times and we don't want duplicate blocks.
        assert!(!state.record_subagent_message_injected("thread_child"));
        assert!(state.record_subagent_message_injected("thread_other"));
    }

    #[test]
    fn record_subagent_prompt_injected_is_one_shot_per_parent_tool_use() {
        // Codex emits the same spawn through both the raw and collab paths,
        // and we synthesize the prompt from whichever arrives first. The
        // second path must never re-emit it under the same Agent block.
        let mut state = IndexState::default();
        assert!(state.record_subagent_prompt_injected("call_spawn_a"));
        assert!(!state.record_subagent_prompt_injected("call_spawn_a"));
        // Different spawns are independent.
        assert!(state.record_subagent_prompt_injected("call_spawn_b"));
    }

    #[test]
    fn subagent_thread_mapping_survives_reset() {
        let mut state = IndexState::default();
        state.record_subagent_thread("thread_child", "toolu_spawn");
        state.record_pending_spawn_call("stale_call", "thread_root", Some("stale_task"));
        state.index_for("anything");
        state.reset();
        // Per-turn caches and unresolved routes are cleared, while established
        // sub-agent mappings outlive turns.
        assert!(!state.has_index("anything"));
        assert_eq!(
            state.take_pending_spawn_route("thread_root", Some("/root/stale_task")),
            None,
        );
        assert_eq!(
            state.subagent_parent_tool_use_id("thread_child"),
            Some("toolu_spawn"),
        );
    }
}
