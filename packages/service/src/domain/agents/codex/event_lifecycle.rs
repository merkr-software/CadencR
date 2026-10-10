//! A Codex session includes the root and its live, user-spawned descendants.
//! Turn boundaries remain the fallback for old CLIs; newer thread status
//! notifications also cover work resumed without a user turn/start request.
mod children;

use std::collections::HashMap;

use serde_json::{json, Value};

use super::event_json::metadata;
use super::event_state::IndexState;
use super::event_turn_state::belongs_to_root_thread;
use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventKind, RuntimeTurnStartedSource};

#[derive(Default)]
pub(super) struct SessionLifecycle {
    root_active: bool,
    explicit_root_turn: bool,
    pending_result: Option<RuntimeEvent>,
    // None means a status notification arrived before the turn id.
    pub(super) children: HashMap<String, Option<String>>,
}

impl SessionLifecycle {
    pub(super) fn apply(
        &mut self,
        method: &str,
        params: &Value,
        root: &str,
        indexes: &IndexState,
        events: &mut Vec<RuntimeEvent>,
    ) {
        // An active thread waiting for the user is not a fresh working turn.
        // The request/permission path owns Question and must not be overwritten.
        if method == "thread/status/changed"
            && params["status"]["activeFlags"]
                .as_array()
                .is_some_and(|flags| !flags.is_empty())
        {
            return;
        }
        let was_working = self.root_active || !self.children.is_empty();
        self.observe_activity(method, params, indexes);
        let is_root = belongs_to_root_thread(params, root);
        if is_root {
            self.observe_root(method, params, root, events);
        } else {
            let thread = params.get("threadId").and_then(Value::as_str).unwrap_or("");
            // Never let a child's Result end the parent, even if its route
            // could not be recovered. Guardian/review threads aren't tasks.
            events.retain(|event| !event.is_result());
            if indexes.subagent_parent_tool_use_id(thread).is_some() {
                self.observe_child(method, params, thread);
            } else {
                events.retain(RuntimeEvent::is_usage_accounting);
            }
        }
        if !self.root_active && !self.children.is_empty() && self.pending_result.is_none() {
            // An already-loaded child can resume after the parent's Result.
            // Its eventual completion must also release the session.
            self.pending_result = Some(RuntimeEvent::new(
                metadata(root, json!({"type":"result", "session_id":root})),
                RuntimeEventKind::Result,
            ));
        }
        if !was_working && !self.children.is_empty() && !self.root_active {
            events.insert(
                0,
                RuntimeEvent::turn_started_signal(
                    Some(root.to_string()),
                    RuntimeTurnStartedSource::ProviderActivity,
                    None,
                ),
            );
        }
        if !self.root_active && self.children.is_empty() {
            if let Some(result) = self.pending_result.take() {
                events.push(result);
            }
        }
    }

    fn observe_root(
        &mut self,
        method: &str,
        params: &Value,
        root: &str,
        events: &mut Vec<RuntimeEvent>,
    ) {
        match method {
            "turn/started" => {
                events.insert(
                    0,
                    RuntimeEvent::turn_started_signal(
                        Some(root.to_string()),
                        RuntimeTurnStartedSource::ProviderActivity,
                        None,
                    ),
                );
                self.root_active = true;
                self.explicit_root_turn = true;
                self.pending_result = None;
            }
            "thread/status/changed" if params["status"]["type"] == "active" => {
                if !self.root_active {
                    self.root_active = true;
                    self.pending_result = None;
                    events.push(RuntimeEvent::turn_started_signal(
                        Some(root.to_string()),
                        RuntimeTurnStartedSource::ProviderActivity,
                        None,
                    ));
                }
            }
            "turn/completed" => {
                self.root_active = false;
                self.explicit_root_turn = false;
                if !self.children.is_empty() {
                    self.defer_result(root, events);
                }
            }
            // Only reconcile status-only activity. An explicit turn still owes
            // us turn/completed (including its error and usage).
            "thread/status/changed"
                if params["status"]["type"] == "idle"
                    && !self.explicit_root_turn
                    && self.root_active =>
            {
                self.root_active = false;
                self.pending_result = Some(RuntimeEvent::new(
                    metadata(root, json!({"type":"result", "session_id":root})),
                    RuntimeEventKind::Result,
                ));
            }
            _ => {}
        }
    }

    fn defer_result(&mut self, root: &str, events: &mut Vec<RuntimeEvent>) {
        let Some(position) = events.iter().position(RuntimeEvent::is_result) else {
            return;
        };
        let result = events.remove(position);
        // Failure must be visible immediately, not after a slow child ends.
        if let Some(error) = result.result_error() {
            events.push(RuntimeEvent::new(
                metadata(root, json!({"type":"error", "message":error.message})),
                RuntimeEventKind::ProviderError {
                    message: error.message.clone(),
                    code: Some(error.code.clone()),
                    parent_tool_use_id: None,
                },
            ));
        }
        self.pending_result = Some(result.with_result_error(None));
    }
}

#[cfg(test)]
mod tests {
    use super::super::events::notification_events;
    use super::*;

    struct Harness {
        lifecycle: SessionLifecycle,
        indexes: IndexState,
    }
    impl Harness {
        fn new() -> Self {
            let mut indexes = IndexState::for_root_thread("root");
            indexes.record_subagent_thread("child", "spawn");
            indexes.record_subagent_thread("other", "spawn2");
            Self {
                lifecycle: SessionLifecycle::default(),
                indexes,
            }
        }
        fn send(&mut self, method: &str, params: Value) -> Vec<RuntimeEvent> {
            let mut events = notification_events(method, params.clone(), None, &mut self.indexes);
            self.lifecycle
                .apply(method, &params, "root", &self.indexes, &mut events);
            events
        }
        fn turn(&mut self, thread: &str, method: &str) -> Vec<RuntimeEvent> {
            self.send(
                method,
                json!({"threadId":thread,"turn":{"id":format!("{thread}-turn")}}),
            )
        }
    }

    #[test]
    fn root_completion_waits_for_all_children_without_requiring_parent_auto_resume() {
        let mut h = Harness::new();
        h.turn("root", "turn/started");
        h.turn("child", "turn/started");
        h.turn("other", "turn/started");
        assert!(!h
            .turn("root", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
        assert!(!h
            .turn("child", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
        let finished = h.turn("other", "turn/completed");
        assert_eq!(finished.iter().filter(|e| e.is_result()).count(), 1);
        assert_eq!(finished.last().unwrap().raw_json()["session_id"], "root");
        assert!(h.turn("other", "turn/completed").is_empty());
    }

    #[test]
    fn child_completion_does_not_end_resumed_root_turn() {
        let mut h = Harness::new();
        h.turn("root", "turn/started");
        h.turn("child", "turn/started");
        h.turn("root", "turn/completed");
        h.turn("root", "turn/started");
        assert!(!h
            .turn("child", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
        assert!(h
            .turn("root", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
    }

    #[test]
    fn legacy_root_only_and_missing_thread_id_complete_normally() {
        let mut h = Harness::new();
        assert!(h.turn("guardian", "turn/started").is_empty());
        h.turn("root", "turn/started");
        assert!(h
            .send("turn/completed", json!({}))
            .iter()
            .any(RuntimeEvent::is_result));
        assert!(!h
            .turn("guardian", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
    }

    #[test]
    fn thread_status_reconciles_background_activity_but_keeps_explicit_turn_error() {
        let mut h = Harness::new();
        let status =
            |thread, kind| json!({"threadId":thread,"status":{"type":kind,"activeFlags":[]}});
        assert!(h
            .send("thread/status/changed", status("root", "active"))
            .iter()
            .any(|e| e.is_turn_started_signal()));
        h.turn("root", "turn/started");
        h.send("thread/status/changed", status("child", "active"));
        assert!(h
            .send("thread/status/changed", status("root", "idle"))
            .is_empty());
        let failed = h.send("turn/completed", json!({"threadId":"root","turn":{"status":"failed","error":{"message":"Selected model is at capacity"}}}));
        assert!(failed.iter().any(|e| e.provider_error().is_some()));
        assert!(!failed.iter().any(RuntimeEvent::is_result));
        assert!(h
            .send("thread/status/changed", status("child", "idle"))
            .iter()
            .any(RuntimeEvent::is_result));
    }

    #[test]
    fn status_only_root_turn_ends_and_unknown_status_is_ignored() {
        let mut h = Harness::new();
        h.send(
            "thread/status/changed",
            json!({"threadId":"root","status":{"type":"active"}}),
        );
        assert!(h
            .send(
                "thread/status/changed",
                json!({"threadId":"root","status":{"type":"future"}})
            )
            .is_empty());
        assert!(h
            .send(
                "thread/status/changed",
                json!({"threadId":"root","status":{"type":"idle"}})
            )
            .iter()
            .any(RuntimeEvent::is_result));
    }
    #[test]
    fn resumed_child_status_alone_reopens_and_releases_completed_session() {
        let mut h = Harness::new();
        h.turn("root", "turn/started");
        h.turn("root", "turn/completed");
        let started = h.send(
            "thread/status/changed",
            json!({"threadId":"child","status":{"type":"active"}}),
        );
        assert!(started.iter().any(RuntimeEvent::is_turn_started_signal));
        assert!(!started.iter().any(RuntimeEvent::is_result));
        assert!(h
            .send("thread/closed", json!({"threadId":"child"}))
            .iter()
            .any(RuntimeEvent::is_result));
    }

    #[test]
    fn parent_activity_tracks_spawn_pending_init_and_completion_without_child_stream() {
        let mut h = Harness::new();
        h.turn("root", "turn/started");
        let activity = |kind| json!({"threadId":"root", "item":{"type":"subAgentActivity", "id":"spawn","agentThreadId":"child","kind":kind}});
        h.send("item/started", activity("started"));
        assert!(!h
            .turn("root", "turn/completed")
            .iter()
            .any(RuntimeEvent::is_result));
        assert!(h
            .send("item/completed", activity("completed"))
            .iter()
            .any(RuntimeEvent::is_result));
        assert!(h.send("item/completed", activity("completed")).is_empty());
    }
    #[test]
    fn waiting_status_does_not_overwrite_question_with_running() {
        let mut h = Harness::new();
        assert!(h.send("thread/status/changed", json!({"threadId":"root","status":{"type":"active","activeFlags":["waitingOnUserInput"]}})).is_empty());
        assert!(h
            .send(
                "thread/status/changed",
                json!({"threadId":"root","status":{"type":"active","activeFlags":[]}})
            )
            .iter()
            .any(RuntimeEvent::is_turn_started_signal));
    }
}
