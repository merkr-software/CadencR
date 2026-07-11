use std::collections::{HashMap, HashSet};

use serde_json::Value;

struct PendingSpawnRoute {
    sender_thread_id: String,
    task_name: Option<String>,
}

#[derive(Default)]
pub(super) struct IndexState {
    next: u64,
    by_id: HashMap<String, u64>,
    canonical_by_id: HashMap<String, String>,
    results: HashSet<String>,
    command_action_items: HashSet<String>,
    delayed_command_inputs: HashMap<String, Value>,
    command_output_snapshots: HashMap<String, String>,
    reasoning_marker_prefixes: HashMap<String, String>,
    suppressed_raw_tool_items: HashSet<String>,
    /// Maps a sub-agent's `threadId` to the `tool_use_id` of the parent
    /// `spawn_agent` collab tool call. Codex routes sub-agent traffic on the
    /// same JSON-RPC stream but with the spawned thread's id, so the codex
    /// adapter uses this map to stamp `parent_tool_use_id` on every event
    /// belonging to a sub-agent thread. Outlives `reset()` because sub-agents
    /// can keep emitting events across multiple root turns.
    subagent_threads: HashMap<String, String>,
    /// Set of `function_call` `call_id`s that were emitted as `spawn_agent`
    /// (normalized to `Agent`) and are still awaiting their matching
    /// `function_call_output`. Codex puts the spawned thread id only in the
    /// tool_result's `agentsStates` keys, so we need to pair the two events
    /// to learn the threadId and register the sub-agent mapping.
    pending_spawn_calls: HashSet<String>,
    /// Spawn call metadata retained until a child routing signal supplies the
    /// thread id.
    pending_spawn_routes: HashMap<String, PendingSpawnRoute>,
    /// `threadId` of the root conversation. The codex app-server multiplexes
    /// every thread (root + every sub-agent) onto a single JSON-RPC stream
    /// and sends `turn/started` for sub-agents too. We must NOT reset the
    /// shared per-turn caches when a sub-agent turn starts, only when the
    /// root's turn starts — otherwise mid-spawn events lose their index and
    /// downstream items emit as duplicates.
    root_thread_id: Option<String>,
    /// `threadId`s for which we've already synthesized a sub-agent message
    /// child block from `agentsStates[threadId].message`. Codex delivers
    /// sub-agent output as a single blob via wait_agent / close_agent
    /// tool_results, possibly more than once; we inject the first non-empty
    /// message and skip subsequent duplicates.
    injected_subagent_messages: HashSet<String>,
    /// `tool_use_id`s of sub-agent spawn calls for which we've already
    /// synthesized the prompt as a child Text block. Codex emits the same
    /// spawn through both the raw `function_call` and the normalized
    /// `collabAgentToolCall` paths; this set keeps the prompt from being
    /// rendered twice no matter which path emits first.
    injected_subagent_prompts: HashSet<String>,
}

impl IndexState {
    pub(super) fn reset(&mut self) {
        self.next = 0;
        self.by_id.clear();
        self.canonical_by_id.clear();
        self.results.clear();
        self.command_action_items.clear();
        self.delayed_command_inputs.clear();
        self.command_output_snapshots.clear();
        self.reasoning_marker_prefixes.clear();
        self.suppressed_raw_tool_items.clear();
        self.pending_spawn_calls.clear();
        self.pending_spawn_routes.clear();
        // `subagent_threads` is intentionally not cleared: sub-agent threads
        // may continue streaming across multiple root turns.
    }

    pub(super) fn has_index(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    pub(super) fn index_for(&mut self, id: &str) -> u64 {
        if let Some(index) = self.by_id.get(id) {
            return *index;
        }
        let index = self.next + 1;
        self.next = index;
        self.by_id.insert(id.to_string(), index);
        self.canonical_by_id
            .entry(id.to_string())
            .or_insert_with(|| id.to_string());
        index
    }

    pub(super) fn alias_index(&mut self, id: &str, canonical_id: &str, index: u64) {
        self.by_id.entry(id.to_string()).or_insert(index);
        self.canonical_by_id
            .entry(id.to_string())
            .or_insert_with(|| canonical_id.to_string());
    }

    pub(super) fn canonical_id(&self, id: &str) -> String {
        self.canonical_by_id
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.to_string())
    }

    pub(super) fn record_result(&mut self, id: &str) -> bool {
        self.results.insert(self.canonical_id(id))
    }

    pub(super) fn record_command_action_item(&mut self, id: &str) {
        self.command_action_items.insert(id.to_string());
    }

    pub(super) fn has_command_action_item(&self, id: &str) -> bool {
        self.command_action_items.contains(id)
    }

    pub(super) fn record_delayed_command_item(&mut self, id: &str, input: Value) {
        self.delayed_command_inputs.insert(id.to_string(), input);
    }

    pub(super) fn take_delayed_command_input(&mut self, id: &str) -> Option<Value> {
        self.delayed_command_inputs.remove(id)
    }

    pub(super) fn clear_delayed_command_input(&mut self, id: &str) {
        self.delayed_command_inputs.remove(id);
    }

    pub(super) fn command_output_delta_from_snapshot(
        &mut self,
        id: &str,
        snapshot: &str,
    ) -> String {
        let previous = self
            .command_output_snapshots
            .insert(id.to_string(), snapshot.to_string())
            .unwrap_or_default();
        snapshot
            .strip_prefix(&previous)
            .unwrap_or(snapshot)
            .to_string()
    }

    pub(super) fn reasoning_delta_without_marker(&mut self, id: &str, delta: &str) -> String {
        const MARKER: &str = "<!-- -->";
        let combined = match self.reasoning_marker_prefixes.remove(id) {
            Some(mut pending) => {
                pending.push_str(delta);
                pending
            }
            None if !delta.contains('<') => return delta.to_string(),
            None => delta.to_string(),
        };
        let mut cleaned = combined.replace(MARKER, "");
        let pending_len = (1..MARKER.len())
            .rev()
            .find(|length| cleaned.ends_with(&MARKER[..*length]))
            .unwrap_or_default();
        if pending_len > 0 {
            let pending = cleaned.split_off(cleaned.len() - pending_len);
            self.reasoning_marker_prefixes
                .insert(id.to_string(), pending);
        }
        cleaned
    }

    pub(super) fn take_reasoning_pending(&mut self, id: &str) -> Option<String> {
        self.reasoning_marker_prefixes.remove(id)
    }

    pub(super) fn record_suppressed_raw_tool_item(&mut self, id: &str) {
        self.suppressed_raw_tool_items.insert(id.to_string());
    }

    pub(super) fn has_suppressed_raw_tool_item(&self, id: &str) -> bool {
        self.suppressed_raw_tool_items.contains(id)
    }

    /// Record that `subagent_thread_id` belongs to a sub-agent spawned by the
    /// `spawn_agent` collab tool call with id `parent_tool_use_id`.
    pub(super) fn record_subagent_thread(
        &mut self,
        subagent_thread_id: &str,
        parent_tool_use_id: &str,
    ) {
        self.subagent_threads.insert(
            subagent_thread_id.to_string(),
            parent_tool_use_id.to_string(),
        );
        self.pending_spawn_routes.remove(parent_tool_use_id);
    }

    /// Returns the `tool_use_id` of the parent `spawn_agent` call if
    /// `thread_id` is a tracked sub-agent thread.
    pub(super) fn subagent_parent_tool_use_id(&self, thread_id: &str) -> Option<&str> {
        self.subagent_threads.get(thread_id).map(String::as_str)
    }

    /// Cheap predicate to short-circuit per-notification post-processing on
    /// turns that never touched a sub-agent. The codex stream multiplexes
    /// every thread; without this, every event would pay for a HashMap
    /// lookup + a `thread_id.to_string()` even when no spawn ever happened.
    pub(super) fn has_any_subagents(&self) -> bool {
        !self.subagent_threads.is_empty()
    }

    /// Mark `call_id` as a `spawn_agent` invocation pending its
    /// `function_call_output` (where the spawned threadId is reported).
    pub(super) fn record_pending_spawn_call(
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
    pub(super) fn take_pending_spawn_call(&mut self, call_id: &str) -> bool {
        self.pending_spawn_calls.remove(call_id)
    }

    pub(super) fn discard_pending_spawn_route(&mut self, call_id: &str) {
        self.pending_spawn_routes.remove(call_id);
    }

    /// Match a child route by parent thread and the task-name segment of its
    /// `agent_path`.
    pub(super) fn take_pending_spawn_route(
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
    pub(super) fn should_reset_for_turn_started(&mut self, thread_id: &str) -> bool {
        match self.root_thread_id.as_deref() {
            None => {
                self.root_thread_id = Some(thread_id.to_string());
                true
            }
            Some(root) => root == thread_id,
        }
    }

    /// Returns true the first time we synthesize a sub-agent message for
    /// `thread_id` (so the caller actually emits the block). Returns false
    /// on subsequent calls so duplicate wait_agent responses don't append
    /// the same message twice under the parent Agent block.
    pub(super) fn record_subagent_message_injected(&mut self, thread_id: &str) -> bool {
        self.injected_subagent_messages
            .insert(thread_id.to_string())
    }

    /// Returns true the first time we synthesize a sub-agent's spawn prompt
    /// child block for `parent_tool_use_id`. Subsequent calls return false
    /// so the prompt is never rendered twice (e.g. when the same spawn
    /// arrives via both the raw and collab paths).
    pub(super) fn record_subagent_prompt_injected(&mut self, parent_tool_use_id: &str) -> bool {
        self.injected_subagent_prompts
            .insert(parent_tool_use_id.to_string())
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
