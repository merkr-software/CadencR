mod items;
mod subagents;

use std::collections::{HashMap, HashSet};

struct PendingSpawnRoute {
    sender_thread_id: String,
    task_name: Option<String>,
}

#[derive(Default)]
pub(super) struct IndexState {
    /// Last stream index handed out; never reset, so indexes stay unique.
    next: u64,
    items: items::ThreadItems,
    /// Maps a sub-agent's `threadId` to the `tool_use_id` of the parent
    /// `spawn_agent` collab tool call. Codex routes sub-agent traffic on the
    /// same JSON-RPC stream but with the spawned thread's id, so the codex
    /// adapter uses this map to stamp `parent_tool_use_id` on every event
    /// belonging to a sub-agent thread. Outlives `reset()` because sub-agents
    /// can keep emitting events across multiple root turns.
    subagent_threads: HashMap<String, String>,
    /// Carriers earlier runtimes recorded for child threads, by thread id. A
    /// child Codex rehydrates is routed back to its own carrier with these.
    known_subagent_carriers: HashMap<String, String>,
    /// Coalesce the started/completed interaction pair, including failed reads.
    subagent_recovery_attempts: HashSet<String>,
    /// `function_call` `call_id`s that were emitted as `spawn_agent`
    /// (normalized to `Agent`) and are still awaiting their matching
    /// `function_call_output`, with the thread that spawned them. Codex puts
    /// the spawned thread id only in the tool_result's `agentsStates` keys,
    /// so we need to pair the two events to learn the threadId and register
    /// the sub-agent mapping.
    pending_spawn_calls: HashMap<String, String>,
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
    /// Codex `error` notifications: retrying threads and surfaced turns.
    pub(super) turn_errors: super::events::TurnErrorState,
}

impl IndexState {
    pub(super) fn for_root_thread(thread_id: &str) -> Self {
        Self {
            root_thread_id: Some(thread_id.to_string()),
            ..Self::default()
        }
    }

    /// Root `turn/started`: drop the per-turn caches, except what a sub-agent
    /// `live_child` still counts as running needs to resolve its late events.
    pub(super) fn reset(&mut self, live_child: impl Fn(&str) -> bool) {
        self.items.reset_root_turn(&live_child);
        self.pending_spawn_calls
            .retain(|_, sender| live_child(sender));
        self.pending_spawn_routes
            .retain(|_, route| live_child(&route.sender_thread_id));
        self.subagent_recovery_attempts.clear();
        self.turn_errors.reset_turns(&live_child);
        // `subagent_threads` is intentionally not cleared: sub-agent threads
        // may continue streaming across multiple root turns.
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
