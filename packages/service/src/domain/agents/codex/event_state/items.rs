//! Per-item caches, partitioned by the thread that wrote them.
//!
//! Codex multiplexes the root thread and every sub-agent thread onto one
//! stream, and a sub-agent spawned in one root turn may keep streaming after
//! the next root turn starts. A root `turn/started` therefore drops only the
//! root's caches and those of children the session lifecycle no longer
//! counts as live; a running child keeps the indexes, ids and pending inputs
//! its late events resolve.
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::super::event_reasoning_state::ReasoningState;
use super::super::event_web::WebEventState;
use super::IndexState;

#[derive(Default)]
struct ItemCaches {
    by_id: HashMap<String, u64>,
    canonical_by_id: HashMap<String, String>,
    results: HashSet<String>,
    command_action_items: HashSet<String>,
    delayed_command_inputs: HashMap<String, Value>,
    command_output_snapshots: HashMap<String, String>,
    /// Streamed command output, replayed into `item/completed` when Codex
    /// omits `aggregatedOutput`.
    command_outputs: HashMap<String, String>,
    reasoning: ReasoningState,
    suppressed_raw_tool_items: HashSet<String>,
    web: WebEventState,
}

#[derive(Default)]
pub(super) struct ThreadItems {
    /// Thread of the notification being handled; empty when it carries none.
    current: String,
    by_thread: HashMap<String, ItemCaches>,
}

impl ThreadItems {
    fn current(&self) -> Option<&ItemCaches> {
        self.by_thread.get(&self.current)
    }

    fn current_mut(&mut self) -> &mut ItemCaches {
        // Streaming deltas land here: allocate the key only for a new thread.
        if !self.by_thread.contains_key(&self.current) {
            self.by_thread
                .insert(self.current.clone(), ItemCaches::default());
        }
        self.by_thread
            .get_mut(&self.current)
            .expect("the current thread's caches were just ensured")
    }

    pub(super) fn reset_root_turn(&mut self, live_child: &impl Fn(&str) -> bool) {
        self.by_thread.retain(|thread, _| live_child(thread));
    }
}

impl IndexState {
    /// Scope the item caches to the thread of the notification being
    /// handled; a notification without `threadId` belongs to the root.
    pub(in crate::domain::agents::codex) fn enter_notification(&mut self, params: &Value) {
        let thread = match params.get("threadId").and_then(Value::as_str) {
            Some(thread) => thread,
            None => self.root_thread_id.as_deref().unwrap_or_default(),
        };
        if self.items.current != thread {
            self.items.current.clear();
            self.items.current.push_str(thread);
        }
    }

    /// A `turn/started` on `thread_id`: the root's resets the per-turn caches
    /// of every thread but the sub-agents `live_child` still counts as
    /// running (the session lifecycle's live children).
    pub(in crate::domain::agents::codex) fn observe_turn_started(
        &mut self,
        thread_id: &str,
        live_child: impl Fn(&str) -> bool,
    ) {
        if self.should_reset_for_turn_started(thread_id) {
            self.reset(live_child);
        }
    }

    pub(in crate::domain::agents::codex) fn has_index(&self, id: &str) -> bool {
        self.items
            .current()
            .is_some_and(|items| items.by_id.contains_key(id))
    }

    /// Indexes are unique for the whole session: a late sub-agent block can
    /// never take the index of a block that already exists in its message.
    pub(in crate::domain::agents::codex) fn index_for(&mut self, id: &str) -> u64 {
        if let Some(index) = self.items.current().and_then(|items| items.by_id.get(id)) {
            return *index;
        }
        let index = self.next + 1;
        self.next = index;
        let items = self.items.current_mut();
        items.by_id.insert(id.to_string(), index);
        items
            .canonical_by_id
            .entry(id.to_string())
            .or_insert_with(|| id.to_string());
        index
    }

    pub(in crate::domain::agents::codex) fn alias_index(
        &mut self,
        id: &str,
        canonical_id: &str,
        index: u64,
    ) {
        let items = self.items.current_mut();
        items.by_id.entry(id.to_string()).or_insert(index);
        items
            .canonical_by_id
            .entry(id.to_string())
            .or_insert_with(|| canonical_id.to_string());
    }

    pub(in crate::domain::agents::codex) fn canonical_id(&self, id: &str) -> String {
        self.items
            .current()
            .and_then(|items| items.canonical_by_id.get(id))
            .cloned()
            .unwrap_or_else(|| id.to_string())
    }

    pub(in crate::domain::agents::codex) fn record_result(&mut self, id: &str) -> bool {
        let canonical = self.canonical_id(id);
        self.items.current_mut().results.insert(canonical)
    }

    pub(in crate::domain::agents::codex) fn record_command_action_item(&mut self, id: &str) {
        self.items
            .current_mut()
            .command_action_items
            .insert(id.to_string());
    }

    pub(in crate::domain::agents::codex) fn has_command_action_item(&self, id: &str) -> bool {
        self.items
            .current()
            .is_some_and(|items| items.command_action_items.contains(id))
    }

    pub(in crate::domain::agents::codex) fn record_delayed_command_item(
        &mut self,
        id: &str,
        input: Value,
    ) {
        self.items
            .current_mut()
            .delayed_command_inputs
            .insert(id.to_string(), input);
    }

    pub(in crate::domain::agents::codex) fn take_delayed_command_input(
        &mut self,
        id: &str,
    ) -> Option<Value> {
        self.items.current_mut().delayed_command_inputs.remove(id)
    }

    pub(in crate::domain::agents::codex) fn clear_delayed_command_input(&mut self, id: &str) {
        self.items.current_mut().delayed_command_inputs.remove(id);
    }

    pub(in crate::domain::agents::codex) fn command_output_delta_from_snapshot(
        &mut self,
        id: &str,
        snapshot: &str,
    ) -> String {
        let previous = self
            .items
            .current_mut()
            .command_output_snapshots
            .insert(id.to_string(), snapshot.to_string())
            .unwrap_or_default();
        snapshot
            .strip_prefix(&previous)
            .unwrap_or(snapshot)
            .to_string()
    }

    pub(in crate::domain::agents::codex) fn command_outputs_mut(
        &mut self,
    ) -> &mut HashMap<String, String> {
        &mut self.items.current_mut().command_outputs
    }

    pub(in crate::domain::agents::codex) fn reasoning_mut(&mut self) -> &mut ReasoningState {
        &mut self.items.current_mut().reasoning
    }

    pub(in crate::domain::agents::codex) fn web_mut(&mut self) -> &mut WebEventState {
        &mut self.items.current_mut().web
    }

    pub(in crate::domain::agents::codex) fn record_suppressed_raw_tool_item(&mut self, id: &str) {
        self.items
            .current_mut()
            .suppressed_raw_tool_items
            .insert(id.to_string());
    }

    pub(in crate::domain::agents::codex) fn has_suppressed_raw_tool_item(&self, id: &str) -> bool {
        self.items
            .current()
            .is_some_and(|items| items.suppressed_raw_tool_items.contains(id))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::super::super::event_lifecycle::SessionLifecycle;
    use super::super::super::events::notification_events;
    use super::IndexState;
    use crate::domain::agents::adapter::{RuntimeEvent, RuntimeStreamEvent};

    #[derive(Default)]
    struct Session {
        state: IndexState,
        lifecycle: SessionLifecycle,
    }

    impl Session {
        fn new() -> Self {
            Self {
                state: IndexState::for_root_thread("root"),
                ..Self::default()
            }
        }

        /// What the event loop does with each notification.
        fn feed(&mut self, method: &str, params: Value) -> Vec<RuntimeEvent> {
            self.state.enter_notification(&params);
            if method == "turn/started" {
                let live = &self.lifecycle.children;
                let thread = params["threadId"].as_str().unwrap_or_default();
                self.state
                    .observe_turn_started(thread, |child| live.contains_key(child));
            }
            let mut events = notification_events(method, params.clone(), None, &mut self.state);
            if method.starts_with("turn/") || method.starts_with("thread/") {
                self.lifecycle
                    .apply(method, &params, "root", &self.state, &mut events);
            }
            events
        }

        fn spawn_running_child(&mut self) {
            self.feed(
                "turn/started",
                json!({ "threadId": "root", "turn": { "id": "t1" } }),
            );
            for item in [
                json!({ "type": "function_call", "call_id": "spawn", "name": "spawn_agent",
                        "arguments": "{\"message\":\"review\"}" }),
                json!({ "type": "function_call_output", "call_id": "spawn",
                        "output": { "agentsStates": { "child": { "status": "pendingInit" } } } }),
            ] {
                self.feed(
                    "rawResponseItem/completed",
                    json!({ "threadId": "root", "item": item }),
                );
            }
            self.feed(
                "turn/started",
                json!({ "threadId": "child", "turn": { "id": "c1" } }),
            );
            let mcp = json!({ "type": "mcpToolCall", "id": "mcp", "server": "docs",
                              "tool": "search", "arguments": {}, "status": "inProgress" });
            self.feed("item/started", json!({ "threadId": "child", "item": mcp }));
            let command = json!({ "type": "commandExecution", "id": "cmd", "command": "ls" });
            self.feed(
                "item/started",
                json!({ "threadId": "child", "item": command }),
            );
        }

        /// The user sends the next prompt.
        fn next_root_turn(&mut self) {
            self.feed(
                "turn/completed",
                json!({ "threadId": "root", "turn": { "id": "t1" } }),
            );
            self.feed(
                "turn/started",
                json!({ "threadId": "root", "turn": { "id": "t2" } }),
            );
        }
    }

    fn block_starts(events: &[RuntimeEvent]) -> usize {
        events
            .iter()
            .filter(|event| {
                matches!(
                    event.stream_event(),
                    Some(RuntimeStreamEvent::ContentBlockStart { .. })
                )
            })
            .count()
    }

    fn mcp_completed() -> Value {
        json!({ "threadId": "child", "item": {
            "type": "mcpToolCall", "id": "mcp", "server": "docs", "tool": "search",
            "arguments": {}, "status": "completed", "result": { "content": [] } } })
    }

    fn enter(state: &mut IndexState, thread: &str) {
        state.enter_notification(&json!({ "threadId": thread }));
    }

    #[test]
    fn a_running_childs_late_events_keep_their_context_across_a_root_turn() {
        let mut session = Session::new();
        session.spawn_running_child();
        session.next_root_turn();

        let output = session.feed(
            "item/commandExecution/outputDelta",
            json!({ "threadId": "child", "itemId": "cmd", "delta": "a.txt" }),
        );
        assert_eq!(block_starts(&output), 1, "running Bash block, {output:?}");
        assert!(output
            .iter()
            .all(|event| event.parent_tool_use_id() == Some("spawn")));

        let completed = session.feed("item/completed", mcp_completed());
        assert_eq!(
            block_starts(&completed),
            0,
            "no second MCP block, {completed:?}"
        );
        assert_eq!(completed.len(), 1);
    }

    /// A child the lifecycle saw end without its `turn/completed` (closed,
    /// crashed) is not kept alive forever.
    #[test]
    fn a_closed_childs_caches_go_with_the_next_root_turn() {
        let mut session = Session::new();
        session.spawn_running_child();
        session.feed("thread/closed", json!({ "threadId": "child" }));
        session.next_root_turn();

        enter(&mut session.state, "child");
        assert!(!session.state.has_index("mcp"));
        assert_eq!(session.state.take_delayed_command_input("cmd"), None);
    }

    #[test]
    fn root_turn_keeps_live_children_and_never_reuses_an_index() {
        let mut state = IndexState::for_root_thread("root");
        enter(&mut state, "root");
        let root_index = state.index_for("root-item");
        enter(&mut state, "live");
        let live_index = state.index_for("live-item");
        enter(&mut state, "gone");
        state.index_for("gone-item");

        enter(&mut state, "root");
        state.observe_turn_started("root", |child| child == "live");

        assert!(!state.has_index("root-item"));
        enter(&mut state, "gone");
        assert!(!state.has_index("gone-item"));
        enter(&mut state, "live");
        assert_eq!(state.index_for("live-item"), live_index);
        // A new block never takes an index already handed out.
        assert!(state.index_for("live-next") > live_index);
        enter(&mut state, "root");
        assert!(state.index_for("root-next") > root_index);
    }

    #[test]
    fn a_sub_agent_turn_start_resets_nothing() {
        let mut state = IndexState::for_root_thread("root");
        enter(&mut state, "root");
        state.index_for("root-item");
        state.observe_turn_started("child", |_| false);
        assert!(state.has_index("root-item"));
    }

    #[test]
    fn item_caches_are_scoped_to_their_thread() {
        let mut state = IndexState::for_root_thread("root");
        enter(&mut state, "child");
        state.index_for("item");
        enter(&mut state, "root");
        assert!(!state.has_index("item"));
        // A notification without `threadId` belongs to the root.
        state.index_for("root-item");
        enter(&mut state, "child");
        state.enter_notification(&json!({}));
        assert!(state.has_index("root-item"));
    }
}
