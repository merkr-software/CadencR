mod subagents;

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::event_reasoning_state::ReasoningState;
use super::event_web::WebEventState;

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
    pub(super) reasoning: ReasoningState,
    suppressed_raw_tool_items: HashSet<String>,
    pub(super) web: WebEventState,
    /// Maps a sub-agent's `threadId` to the `tool_use_id` of the parent
    /// `spawn_agent` collab tool call. Codex routes sub-agent traffic on the
    /// same JSON-RPC stream but with the spawned thread's id, so the codex
    /// adapter uses this map to stamp `parent_tool_use_id` on every event
    /// belonging to a sub-agent thread. Outlives `reset()` because sub-agents
    /// can keep emitting events across multiple root turns.
    subagent_threads: HashMap<String, String>,
    /// Coalesce the started/completed interaction pair, including failed reads.
    subagent_recovery_attempts: HashSet<String>,
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
    /// Raw Responses API usage waiting for the matching token-usage snapshot.
    /// Pairing both notifications gives fresh and resumed threads one durable
    /// replay identity without counting the same response twice.
    pub(super) pending_raw_usage: super::event_usage::PendingUsageBuffer,
    /// What each sub-agent child last reported to the registry. Outlives
    /// `reset()` like `subagent_threads`.
    pub(super) subagent_reports: super::event_subagent_reports::SubagentReports,
}

impl IndexState {
    pub(super) fn for_root_thread(thread_id: &str) -> Self {
        Self {
            root_thread_id: Some(thread_id.to_string()),
            ..Self::default()
        }
    }

    pub(super) fn reset(&mut self) {
        self.next = 0;
        self.by_id.clear();
        self.canonical_by_id.clear();
        self.results.clear();
        self.command_action_items.clear();
        self.delayed_command_inputs.clear();
        self.command_output_snapshots.clear();
        self.reasoning.reset();
        self.suppressed_raw_tool_items.clear();
        self.web.reset();
        self.pending_spawn_calls.clear();
        self.pending_spawn_routes.clear();
        self.subagent_recovery_attempts.clear();
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

    pub(super) fn record_suppressed_raw_tool_item(&mut self, id: &str) {
        self.suppressed_raw_tool_items.insert(id.to_string());
    }

    pub(super) fn has_suppressed_raw_tool_item(&self, id: &str) -> bool {
        self.suppressed_raw_tool_items.contains(id)
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
