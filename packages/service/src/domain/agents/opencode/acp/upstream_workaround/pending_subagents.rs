//! Task/Agent tool calls shared between the OpenCode ACP adapter (which sees
//! the parent's tool calls) and the polling listener (which sees the child
//! sessions they spawn).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};

/// Tracks open Task/Agent tool calls waiting to be paired with a child
/// session. Prefer an explicit `sessionId`/`task_id` binding when OpenCode
/// surfaces one; fall back to FIFO for the race where the child appears
/// before the tool update carrying that id. Also remembers which tool calls
/// launched a background sub-agent, whose end only the listener can see,
/// and which ones the listener tails: it streams their whole transcript,
/// report included, so the parent's completion must not repeat it.
#[derive(Debug, Default)]
pub struct PendingSubagentState {
    unbound: VecDeque<String>,
    by_child_session: HashMap<String, String>,
    background: HashSet<String>,
    tailed: HashSet<String>,
}

impl PendingSubagentState {
    pub fn push_tool_call(&mut self, tool_call_id: String) {
        if self.unbound.iter().any(|id| id == &tool_call_id)
            || self.by_child_session.values().any(|id| id == &tool_call_id)
        {
            return;
        }
        self.unbound.push_back(tool_call_id);
    }

    /// Remember that `tool_call_id` owns `child_session_id` so absorb can
    /// pair without relying on FIFO order. No-ops when the mapping is
    /// unchanged or the tool call was already consumed by FIFO pairing
    /// (avoids orphan bindings that keep the listener permanently active).
    pub fn bind_child_session(&mut self, child_session_id: &str, tool_call_id: &str) {
        if child_session_id.is_empty() || tool_call_id.is_empty() {
            return;
        }
        if self
            .by_child_session
            .get(child_session_id)
            .map(String::as_str)
            == Some(tool_call_id)
        {
            return;
        }
        let still_pending = self.unbound.iter().any(|id| id == tool_call_id)
            || self.by_child_session.values().any(|id| id == tool_call_id);
        if !still_pending {
            return;
        }
        self.unbound.retain(|id| id != tool_call_id);
        self.by_child_session.retain(|_, id| id != tool_call_id);
        self.by_child_session
            .insert(child_session_id.to_string(), tool_call_id.to_string());
    }

    pub fn take_for_child(&mut self, child_session_id: &str) -> Option<String> {
        if let Some(id) = self.take_bound_for_child(child_session_id) {
            return Some(id);
        }
        self.unbound.pop_front()
    }

    /// Only an explicit binding: a finished child resumed through `task_id`
    /// must never steal another tool call by FIFO.
    pub fn take_bound_for_child(&mut self, child_session_id: &str) -> Option<String> {
        self.by_child_session.remove(child_session_id)
    }

    pub fn is_empty(&self) -> bool {
        self.unbound.is_empty() && self.by_child_session.is_empty()
    }

    pub fn mark_background(&mut self, tool_call_id: &str) {
        self.background.insert(tool_call_id.to_string());
    }

    pub fn is_background(&self, tool_call_id: &str) -> bool {
        self.background.contains(tool_call_id)
    }

    /// The listener retired the call's child. A foreground call's tailed mark
    /// stays for the parent's completion, which may still be on its way; a
    /// background call's completion (its launch) came first, so nothing
    /// will read it.
    pub fn forget_background(&mut self, tool_call_id: &str) {
        if self.background.remove(tool_call_id) {
            self.tailed.remove(tool_call_id);
        }
    }

    /// The listener paired a child with `tool_call_id` and streams it.
    pub fn mark_tailed(&mut self, tool_call_id: &str) {
        self.tailed.insert(tool_call_id.to_string());
    }

    /// Whether the listener streams this tool call's child (and so its
    /// report, even one it has not polled yet). Read once: the call is over.
    pub fn take_tailed(&mut self, tool_call_id: &str) -> bool {
        self.tailed.remove(tool_call_id)
    }
}

pub type PendingSubagentTasks = Arc<StdMutex<PendingSubagentState>>;

#[cfg(test)]
mod tests {
    use super::PendingSubagentState;

    #[test]
    fn bound_take_never_falls_back_to_fifo() {
        let mut pending = PendingSubagentState::default();
        pending.push_tool_call("call_new".into());
        assert_eq!(pending.take_bound_for_child("ses_old"), None);
        pending.bind_child_session("ses_old", "call_new");
        assert_eq!(
            pending.take_bound_for_child("ses_old").as_deref(),
            Some("call_new")
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn a_tailed_call_is_recognised_once() {
        let mut pending = PendingSubagentState::default();
        assert!(!pending.take_tailed("call"));
        pending.mark_tailed("call");
        assert!(pending.is_empty(), "a tailed mark keeps nothing pending");
        assert!(pending.take_tailed("call"));
        assert!(!pending.take_tailed("call"));
    }

    #[test]
    fn retiring_a_foreground_child_keeps_its_tailed_mark() {
        let mut pending = PendingSubagentState::default();
        pending.mark_tailed("call_fg");
        pending.forget_background("call_fg");
        assert!(pending.take_tailed("call_fg"));

        pending.mark_background("call_bg");
        pending.mark_tailed("call_bg");
        pending.forget_background("call_bg");
        assert!(!pending.take_tailed("call_bg"));
    }

    #[test]
    fn background_marks_do_not_keep_the_listener_active() {
        let mut pending = PendingSubagentState::default();
        pending.mark_background("call_bg");
        assert!(pending.is_empty());
        assert!(pending.is_background("call_bg"));
        pending.forget_background("call_bg");
        assert!(!pending.is_background("call_bg"));
    }
}
