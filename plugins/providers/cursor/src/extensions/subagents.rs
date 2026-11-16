//! Cursor sub-agent sessions, negotiated through `clientCapabilities.subagents`.
//!
//! cursor-agent 2026.10.22 announces each sub-agent on the parent session as
//! `subagent_spawned {subagentSessionId, _meta.cursor.toolCallId}`, streams
//! the child's own updates under `subagentSessionId`, and ends it with
//! `subagent_state_update {subagentSessionId, state, _meta.cursor.toolCallId}`
//! (`completed`, `failed`, `cancelled` or `disconnected`). With the capability
//! Cursor also holds the parent's `session/prompt` open until background runs
//! finish, then answers it after a summary message.
//!
//! Cadencr only knows the parent session: child tool calls are re-addressed to
//! it and nested under the launching `Agent` call with `parentToolCallId`, the
//! child's text is kept as the run's summary, and the end becomes a
//! `tool_call_update` of the launching call carrying
//! `_meta.cadencr.subagent.status`.

use std::collections::HashMap;

use cadencr_provider_sdk::meta::{merge_meta, subagent_status_meta, SubagentStatus};
use serde_json::{json, Map, Value};

/// Summary text kept per run: the tail of the child's messages.
const SUMMARY_LIMIT: usize = 4096;

#[derive(Debug, Clone, PartialEq)]
pub struct SubagentLink {
    pub parent_session: String,
    pub tool_call_id: String,
    text: String,
}

/// Live sub-agent sessions, keyed by the child's session id.
#[derive(Debug, Default)]
pub struct SubagentSessions(HashMap<String, SubagentLink>);

impl SubagentSessions {
    /// Record a `subagent_spawned` update seen on `parent_session`.
    pub fn spawned(&mut self, parent_session: &str, update: &Map<String, Value>) {
        let (Some(child), Some(tool_call_id)) = (child_session(update), launching_call(update))
        else {
            eprintln!(
                "cursor connector: `subagent_spawned` without a child session or launching \
                 call; its updates stay unlinked"
            );
            return;
        };
        // A sub-agent's own sub-agent reports to the session Cadencr knows;
        // its calls still nest under its own launching call.
        let parent_session = self
            .0
            .get(parent_session)
            .map_or(parent_session, |outer| outer.parent_session.as_str())
            .to_string();
        self.0.insert(
            child.to_string(),
            SubagentLink {
                parent_session,
                tool_call_id: tool_call_id.to_string(),
                text: String::new(),
            },
        );
    }

    pub fn link(&self, child_session: &str) -> Option<&SubagentLink> {
        self.0.get(child_session)
    }

    /// Keep the child's `agent_message_chunk` text as the run's summary.
    pub fn record_text(&mut self, child_session: &str, update: &Map<String, Value>) {
        let text = update
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str);
        if let (Some(link), Some(text)) = (self.0.get_mut(child_session), text) {
            link.text.push_str(text);
            if link.text.len() > SUMMARY_LIMIT {
                let mut cut = link.text.len() - SUMMARY_LIMIT;
                while !link.text.is_char_boundary(cut) {
                    cut += 1;
                }
                link.text.drain(..cut);
            }
        }
    }

    /// A `subagent_state_update` → the parent session (when the run was
    /// linked) and the launching call's `tool_call_update` ending the run, or
    /// `None` for a state that ends nothing.
    pub fn finished(&mut self, update: &Map<String, Value>) -> Option<(Option<String>, Value)> {
        let status = match update.get("state").and_then(Value::as_str)? {
            "completed" => SubagentStatus::Completed,
            "failed" | "disconnected" => SubagentStatus::Failed,
            "cancelled" => SubagentStatus::Cancelled,
            _ => return None,
        };
        let link = child_session(update).and_then(|child| self.0.remove(child));
        let tool_call_id = launching_call(update)
            .map(ToOwned::to_owned)
            .or_else(|| link.as_ref().map(|link| link.tool_call_id.clone()))?;
        let summary = link
            .as_ref()
            .map(|link| link.text.trim())
            .filter(|text| !text.is_empty());
        let mut finished = Map::new();
        finished.insert("sessionUpdate".into(), json!("tool_call_update"));
        finished.insert("toolCallId".into(), json!(tool_call_id));
        merge_meta(&mut finished, subagent_status_meta(status, summary));
        let parent = link.map(|link| link.parent_session);
        Some((parent, Value::Object(finished)))
    }
}

/// Nest a child tool call under the call that launched its sub-agent.
pub fn nest_child_tool_update(update: &mut Map<String, Value>, link: &SubagentLink) {
    update.insert(
        "parentToolCallId".to_string(),
        Value::String(link.tool_call_id.clone()),
    );
}

/// Whether a child tool update belongs to the child's own todo list, which
/// would replace the parent's.
pub fn is_child_todo_update(update: &Map<String, Value>) -> bool {
    update.get("name").and_then(Value::as_str) == Some("TodoWrite")
}

fn child_session(update: &Map<String, Value>) -> Option<&str> {
    update.get("subagentSessionId").and_then(Value::as_str)
}

fn launching_call(update: &Map<String, Value>) -> Option<&str> {
    update
        .get("_meta")
        .and_then(|meta| meta.pointer("/cursor/toolCallId"))
        .and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::{nest_child_tool_update, SubagentSessions, SUMMARY_LIMIT};
    use serde_json::{json, Map, Value};

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn spawned() -> Map<String, Value> {
        object(json!({
            "sessionUpdate": "subagent_spawned",
            "subagentSessionId": "child-1",
            "_meta": { "cursor": { "toolCallId": "task-1" } }
        }))
    }

    #[test]
    fn child_tool_calls_nest_under_the_launching_call() {
        let mut sessions = SubagentSessions::default();
        sessions.spawned("parent", &spawned());
        let link = sessions.link("child-1").unwrap();
        assert_eq!(link.parent_session, "parent");
        let mut update = object(json!({ "sessionUpdate": "tool_call", "toolCallId": "t-9" }));
        nest_child_tool_update(&mut update, link);
        assert_eq!(update["parentToolCallId"], "task-1");
    }

    #[test]
    fn nested_sub_agents_report_to_the_root_session() {
        let mut sessions = SubagentSessions::default();
        sessions.spawned("parent", &spawned());
        let nested = object(json!({
            "sessionUpdate": "subagent_spawned",
            "subagentSessionId": "grandchild",
            "_meta": { "cursor": { "toolCallId": "task-inner" } }
        }));
        sessions.spawned("child-1", &nested);
        let link = sessions.link("grandchild").unwrap();
        assert_eq!(link.parent_session, "parent");
        assert_eq!(link.tool_call_id, "task-inner");
    }

    #[test]
    fn the_end_finishes_the_launching_call_with_the_child_text() {
        let mut sessions = SubagentSessions::default();
        sessions.spawned("parent", &spawned());
        for text in ["FINI", "SHED "] {
            let chunk = object(json!({ "content": { "type": "text", "text": text } }));
            sessions.record_text("child-1", &chunk);
        }
        let state = object(json!({
            "sessionUpdate": "subagent_state_update",
            "subagentSessionId": "child-1",
            "state": "completed",
            "_meta": { "cursor": { "toolCallId": "task-1" } }
        }));
        let (parent, finished) = sessions.finished(&state).unwrap();
        assert_eq!(parent.as_deref(), Some("parent"));
        assert_eq!(finished["sessionUpdate"], "tool_call_update");
        assert_eq!(finished["toolCallId"], "task-1");
        assert!(finished.get("status").is_none());
        let subagent = &finished["_meta"]["cadencr"]["subagent"];
        assert_eq!(subagent["status"], "completed");
        assert_eq!(subagent["summary"], "FINISHED");
        assert!(sessions.link("child-1").is_none());
    }

    #[test]
    fn disconnects_fail_and_unknown_states_end_nothing() {
        let mut sessions = SubagentSessions::default();
        let state = |state: &str| {
            object(json!({
                "subagentSessionId": "child-2",
                "state": state,
                "_meta": { "cursor": { "toolCallId": "task-2" } }
            }))
        };
        assert!(sessions.finished(&state("running")).is_none());
        let (parent, failed) = sessions.finished(&state("disconnected")).unwrap();
        assert_eq!(parent, None);
        assert_eq!(failed["_meta"]["cadencr"]["subagent"]["status"], "failed");
        assert!(failed["_meta"]["cadencr"]["subagent"]
            .get("summary")
            .is_none());
    }

    #[test]
    fn the_summary_keeps_the_tail_of_long_output() {
        let mut sessions = SubagentSessions::default();
        sessions.spawned("parent", &spawned());
        let long = "é".repeat(SUMMARY_LIMIT);
        sessions.record_text("child-1", &object(json!({ "content": { "text": long } })));
        sessions.record_text("child-1", &object(json!({ "content": { "text": "end" } })));
        let text = &sessions.link("child-1").unwrap().text;
        assert!(text.len() <= SUMMARY_LIMIT);
        assert!(text.ends_with("end"));
    }
}
