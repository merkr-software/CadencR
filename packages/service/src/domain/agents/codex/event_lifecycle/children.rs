//! Child lifecycle never changes the identity or completion of the root.
use super::super::event_state::IndexState;
use super::SessionLifecycle;
use serde_json::Value;

impl SessionLifecycle {
    pub(super) fn observe_activity(&mut self, method: &str, params: &Value, indexes: &IndexState) {
        if method == "thread/started" {
            let thread = &params["thread"];
            if let Some(id) = thread["id"]
                .as_str()
                .filter(|id| indexes.subagent_parent_tool_use_id(id).is_some())
            {
                if thread["status"]["type"] == "active" {
                    self.children.entry(id.to_string()).or_default();
                }
            }
        }
        if !matches!(method, "item/started" | "item/completed")
            || params["item"]["type"] != "subAgentActivity"
            || params["threadId"]
                .as_str()
                .is_some_and(|sender| indexes.is_untracked_thread(sender))
        {
            return;
        }
        let item = &params["item"];
        let Some(id) = item["agentThreadId"]
            .as_str()
            .filter(|id| indexes.subagent_parent_tool_use_id(id).is_some())
        else {
            return;
        };
        match item["kind"].as_str() {
            Some("started") => {
                self.children.entry(id.to_string()).or_default();
            }
            Some("completed" | "interrupted") => {
                self.children.remove(id);
            }
            // send_message can target an idle child without starting it.
            _ => {}
        }
    }

    pub(super) fn observe_child(&mut self, method: &str, params: &Value, thread: &str) {
        match method {
            "turn/started" => {
                self.children.insert(
                    thread.to_string(),
                    params["turn"]["id"].as_str().map(ToOwned::to_owned),
                );
            }
            "thread/status/changed" if params["status"]["type"] == "active" => {
                self.children.entry(thread.to_string()).or_default();
            }
            "turn/completed" => {
                let completed = params["turn"]["id"].as_str();
                let active = self.children.get(thread).and_then(|id| id.as_deref());
                if completed.is_none() || active.is_none() || completed == active {
                    self.children.remove(thread);
                }
            }
            "thread/closed" => {
                self.children.remove(thread);
            }
            "thread/status/changed"
                if matches!(
                    params["status"]["type"].as_str(),
                    Some("idle" | "notLoaded" | "systemError")
                ) =>
            {
                self.children.remove(thread);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::events::notification_events;
    use super::*;
    use crate::domain::agents::adapter::RuntimeEvent;
    use serde_json::json;

    fn send(
        lifecycle: &mut SessionLifecycle,
        indexes: &mut IndexState,
        method: &str,
        params: Value,
    ) -> Vec<RuntimeEvent> {
        let mut events = notification_events(method, params.clone(), None, indexes);
        lifecycle.apply(method, &params, "root", indexes, &mut events);
        events
    }

    #[test]
    fn foreign_activity_cannot_start_or_finish_a_tracked_child() {
        let mut indexes = IndexState::for_root_thread("root");
        let mut lifecycle = SessionLifecycle::default();
        indexes.record_subagent_thread("child", "spawn");
        for kind in ["started", "completed", "interrupted"] {
            assert!(send(
                &mut lifecycle,
                &mut indexes,
                "item/completed",
                json!({"threadId":"foreign","item":{"type":"subAgentActivity",
                    "kind":kind,"agentThreadId":"child"}})
            )
            .is_empty());
            assert!(lifecycle.children.is_empty());
        }
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/started",
            json!({"threadId":"root","turn":{"id":"r1"}}),
        );
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/started",
            json!({"threadId":"child","turn":{"id":"c1"}}),
        );
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"root","turn":{"id":"r1"}}),
        );
        for kind in ["started", "completed", "interrupted"] {
            assert!(send(
                &mut lifecycle,
                &mut indexes,
                "item/completed",
                json!({"threadId":"foreign","item":{"type":"subAgentActivity",
                    "kind":kind,"agentThreadId":"child"}})
            )
            .is_empty());
            assert_eq!(lifecycle.children["child"].as_deref(), Some("c1"));
        }
        let done = send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"child","turn":{"id":"c1"}}),
        );
        assert_eq!(done.iter().filter(|e| e.is_result()).count(), 1);
    }

    #[test]
    fn child_to_parent_messages_preserve_root_content_errors_and_later_turns() {
        let mut indexes = IndexState::for_root_thread("root");
        let mut lifecycle = SessionLifecycle::default();
        indexes.record_subagent_thread("child", "spawn");
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/started",
            json!({"threadId":"root","turn":{"id":"r1"}}),
        );
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/started",
            json!({"threadId":"child","turn":{"id":"c1"}}),
        );
        // The production regression: backend sends a message to /root. Both
        // item notifications describe the same interaction, not a new child.
        for method in ["item/started", "item/completed"] {
            let events = send(
                &mut lifecycle,
                &mut indexes,
                method,
                json!({"threadId":"child","item":{
                    "type":"subAgentActivity","id":"send-parent","kind":"interacted","agentThreadId":"root","agentPath":"/root"
                }}),
            );
            assert!(events.is_empty());
        }
        let text = send(
            &mut lifecycle,
            &mut indexes,
            "item/agentMessage/delta",
            json!({"threadId":"root","itemId":"reply","delta":"root answer"}),
        );
        assert!(text.iter().all(|e| e.parent_tool_use_id().is_none()));
        let done = send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"root","turn":{"id":"r1"}}),
        );
        assert!(!done.iter().any(RuntimeEvent::is_result)); // real child still runs
        let done = send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"child","turn":{"id":"c1"}}),
        );
        assert_eq!(done.iter().filter(|e| e.is_result()).count(), 1);
        assert!(send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"child","turn":{"id":"c1"}})
        )
        .is_empty());
        indexes.reset(|_| false);
        send(
            &mut lifecycle,
            &mut indexes,
            "turn/started",
            json!({"threadId":"root","turn":{"id":"r2"}}),
        );
        let failed = send(
            &mut lifecycle,
            &mut indexes,
            "turn/completed",
            json!({"threadId":"root","turn":{"id":"r2","status":"failed","error":{"message":"root failure"}}}),
        );
        let result = failed.iter().find(|e| e.is_result()).unwrap();
        assert_eq!(result.result_error().unwrap().message, "root failure");
        assert!(result.parent_tool_use_id().is_none());
    }

    #[test]
    fn untracked_thread_content_and_spawns_do_not_pollute_the_session() {
        let mut indexes = IndexState::for_root_thread("root");
        let mut lifecycle = SessionLifecycle::default();
        let activity = json!({"threadId":"foreign","item":{"type":"subAgentActivity","id":"spawn","kind":"started","agentThreadId":"foreign-child"}});
        assert!(send(&mut lifecycle, &mut indexes, "item/completed", activity).is_empty());
        assert!(!indexes.has_any_subagents());
        let unknown = json!({"threadId":"unknown","itemId":"text","delta":"not root content"});
        assert!(send(
            &mut lifecycle,
            &mut indexes,
            "item/agentMessage/delta",
            unknown
        )
        .is_empty());
        assert!(!indexes.has_index("text"));
        let spoofed = json!({"threadId":"root","item":{"type":"subAgentActivity","id":"spawn-root","kind":"started","agentThreadId":"root"}});
        assert!(send(&mut lifecycle, &mut indexes, "item/completed", spoofed).is_empty());
        assert!(!indexes.has_any_subagents());
        assert!(lifecycle.children.is_empty());
    }
}
