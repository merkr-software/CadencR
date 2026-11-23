//! OpenCode 2.x sub-agents onto the host's background sub-agent convention.
//!
//! The `subagent` tool returns as soon as it launched a child session
//! (`rawOutput.metadata = {sessionID, status: "running"}`) and the child keeps
//! working after the prompt ends. With the client capability
//! `_meta["opencode/child-session-updates"]`, OpenCode reports the child through
//! `opencode/session/child_update` notifications: `type: "status"` (`created`,
//! `running`, `completed`, `failed`, `interrupted`) and `type: "update"`
//! carrying an ordinary `SessionUpdate`.
//!
//! The wire declares the launch `background` on its completing update, nests
//! the child's tool calls under the launching call (`parentToolCallId`, ids
//! prefixed `<childSessionID>:` like OpenCode's own projection) and finishes
//! the run with `_meta.cadencr.subagent.status` and the child's final text.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Value};

use super::session_update;

const SUBAGENT_TOOL: &str = "subagent";
/// Child updates kept while the launching call is not known yet.
const MAX_BUFFERED_UPDATES: usize = 256;

#[derive(Default)]
pub(super) struct Subagents {
    /// Launching calls not yet bound to a child, per session that made them.
    pending_launches: HashMap<String, VecDeque<String>>,
    /// Ids (as the client sees them) of every `subagent` call.
    launches: HashSet<String>,
    /// Child session → launching call.
    parents: HashMap<String, String>,
    /// Running children and the text they replied so far.
    open: HashMap<String, String>,
    buffered: HashMap<String, Vec<Value>>,
}

impl Subagents {
    pub(super) fn open_count(&self) -> usize {
        self.open.len()
    }

    /// Track a `subagent` call in `session` (the root, or a child for a nested
    /// launch) and mark the launch acknowledgement as a background launch.
    /// Returns the updates of a child this binds that were waiting for it.
    pub(super) fn observe_tool_update(&mut self, session: &str, update: &mut Value) -> Vec<Value> {
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        let Some(id) = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Vec::new();
        };
        if kind == Some("tool_call")
            && update.get("name").and_then(Value::as_str) == Some(SUBAGENT_TOOL)
            && self.launches.insert(id.clone())
        {
            self.pending_launches
                .entry(session.to_owned())
                .or_default()
                .push_back(id.clone());
        }
        if kind != Some("tool_call_update") || !self.launches.contains(&id) {
            return Vec::new();
        }
        let metadata = update.pointer("/rawOutput/metadata");
        let child = metadata
            .and_then(|metadata| metadata.get("sessionID"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let running = metadata
            .and_then(|metadata| metadata.get("status"))
            .and_then(Value::as_str)
            == Some("running");
        if running && update.get("status").and_then(Value::as_str) == Some("completed") {
            update["_meta"]["cadencr"]["subagent"] = json!({ "background": true });
        }
        let finished = matches!(
            update.get("status").and_then(Value::as_str),
            Some("completed" | "failed")
        );
        match child {
            Some(child) => self.bind(session, &child, &id),
            None => {
                // A launch that failed or was denied never starts a child.
                if finished {
                    self.forget_pending(session, &id);
                }
                Vec::new()
            }
        }
    }

    fn forget_pending(&mut self, session: &str, launch: &str) {
        if let Some(queue) = self.pending_launches.get_mut(session) {
            queue.retain(|pending| pending != launch);
        }
    }

    /// The raw `child_update` params that waited for this binding.
    fn bind(&mut self, session: &str, child: &str, launch: &str) -> Vec<Value> {
        self.forget_pending(session, launch);
        self.parents.insert(child.to_owned(), launch.to_owned());
        self.buffered.remove(child).unwrap_or_default()
    }

    /// A `type: "status"` child notification: the messages for the client.
    pub(super) fn child_status(&mut self, params: &Value) -> Vec<Value> {
        let Some(child) = params.get("childSessionId").and_then(Value::as_str) else {
            return Vec::new();
        };
        let child = child.to_owned();
        match params.get("status").and_then(Value::as_str) {
            Some("created" | "running") => {
                self.open.entry(child.clone()).or_default();
                if self.parents.contains_key(&child) {
                    return Vec::new();
                }
                let parent_session = params
                    .get("parentSessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                // OpenCode creates the child before the launch acknowledges it
                // with its id: bind early only when the launch is unambiguous,
                // otherwise the child's updates wait for that acknowledgement.
                let launch = self
                    .pending_launches
                    .get_mut(parent_session)
                    .filter(|queue| queue.len() == 1)
                    .and_then(VecDeque::pop_front);
                let Some(launch) = launch else {
                    return Vec::new();
                };
                let parent_session = parent_session.to_owned();
                let waiting = self.bind(&parent_session, &child, &launch);
                waiting
                    .into_iter()
                    .flat_map(|params| self.child_update(params))
                    .collect()
            }
            Some(status @ ("completed" | "failed" | "interrupted")) => {
                let summary = self.open.remove(&child).unwrap_or_default();
                self.buffered.remove(&child);
                let Some(launch) = self.parents.get(&child) else {
                    return Vec::new();
                };
                let mut finish = json!({ "status": finish_status(status) });
                let summary = match (status, params.pointer("/error/message")) {
                    ("failed", Some(Value::String(message))) => message.clone(),
                    _ => summary.trim().to_owned(),
                };
                if !summary.is_empty() {
                    finish["summary"] = Value::String(summary);
                }
                vec![root_session_update(
                    params,
                    json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": launch,
                        "_meta": { "cadencr": { "subagent": finish } },
                    }),
                )]
            }
            _ => Vec::new(),
        }
    }

    /// A `type: "update"` child notification: the messages for the client.
    /// Child tool calls nest under the launching call; the child's reply text
    /// is kept for its completion summary; anything else stays in the child.
    pub(super) fn child_update(&mut self, mut params: Value) -> Vec<Value> {
        let Some(child) = params
            .get("childSessionId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Vec::new();
        };
        let kind = params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str);
        match kind {
            Some("agent_message_chunk") => {
                let text = params
                    .pointer("/update/content/text")
                    .and_then(Value::as_str);
                // Text of a child that already finished (or never opened)
                // must not reopen it: an open child holds the conversation.
                if let (Some(text), Some(reply)) = (text, self.open.get_mut(&child)) {
                    reply.push_str(text);
                }
                Vec::new()
            }
            Some("tool_call" | "tool_call_update") => {
                let Some(launch) = self.parents.get(&child).cloned() else {
                    self.buffer(child, params);
                    return Vec::new();
                };
                let mut update = params["update"].take();
                if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                    if !id.starts_with(&format!("{child}:")) {
                        update["toolCallId"] = Value::String(format!("{child}:{id}"));
                    }
                }
                update["parentToolCallId"] = Value::String(launch);
                let waiting = self.observe_tool_update(&child, &mut update);
                let mut messages = vec![root_session_update(&params, update)];
                for buffered in waiting {
                    messages.extend(self.child_update(buffered));
                }
                messages
            }
            _ => Vec::new(),
        }
    }

    fn buffer(&mut self, child: String, params: Value) {
        let buffered = self.buffered.entry(child).or_default();
        if buffered.len() >= MAX_BUFFERED_UPDATES {
            return;
        }
        buffered.push(params);
        if buffered.len() == MAX_BUFFERED_UPDATES {
            tracing::warn!(
                limit = MAX_BUFFERED_UPDATES,
                "OpenCode sub-agent updates filled the buffer before their launch was known; \
                 later ones are not shown"
            );
        }
    }
}

fn finish_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        _ => "cancelled",
    }
}

fn root_session_update(params: &Value, update: Value) -> Value {
    session_update(
        params.get("rootSessionId").cloned().unwrap_or(Value::Null),
        update,
    )
}

#[cfg(test)]
mod tests {
    use super::Subagents;
    use serde_json::{json, Value};

    fn launch(subagents: &mut Subagents, id: &str) {
        let mut start = json!({
            "sessionUpdate": "tool_call", "toolCallId": id, "name": "subagent", "status": "pending"
        });
        assert!(subagents.observe_tool_update("root", &mut start).is_empty());
    }

    fn launched(id: &str, child: &str) -> Value {
        json!({
            "sessionUpdate": "tool_call_update", "toolCallId": id, "status": "completed",
            "rawOutput": { "metadata": { "sessionID": child, "status": "running" } }
        })
    }

    fn status(child: &str, status: &str) -> Value {
        json!({
            "rootSessionId": "root", "childSessionId": child, "parentSessionId": "root",
            "depth": 1, "type": "status", "status": status
        })
    }

    fn child_update(child: &str, update: Value) -> Value {
        json!({
            "rootSessionId": "root", "childSessionId": child, "parentSessionId": "root",
            "depth": 1, "type": "update", "update": update
        })
    }

    #[test]
    fn a_launch_acknowledgement_is_a_background_launch() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        let mut ack = launched("t1", "ses_c");
        subagents.observe_tool_update("root", &mut ack);
        assert_eq!(
            ack["_meta"]["cadencr"]["subagent"],
            json!({ "background": true })
        );
    }

    #[test]
    fn child_tools_nest_under_the_launch_and_completion_carries_the_reply() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        assert!(subagents
            .child_status(&status("ses_c", "created"))
            .is_empty());
        assert_eq!(subagents.open_count(), 1);
        let messages = subagents.child_update(child_update(
            "ses_c",
            json!({ "sessionUpdate": "tool_call", "toolCallId": "x", "name": "shell" }),
        ));
        assert_eq!(messages.len(), 1);
        let update = &messages[0]["params"]["update"];
        assert_eq!(messages[0]["params"]["sessionId"], "root");
        assert_eq!(update["toolCallId"], "ses_c:x");
        assert_eq!(update["parentToolCallId"], "t1");
        assert!(subagents
            .child_update(child_update(
                "ses_c",
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "CHILD DONE" } }),
            ))
            .is_empty());

        let finished = subagents.child_status(&status("ses_c", "completed"));
        assert_eq!(
            finished[0]["params"]["update"],
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "t1",
                "_meta": { "cadencr": { "subagent": { "status": "completed", "summary": "CHILD DONE" } } }
            })
        );
        assert_eq!(subagents.open_count(), 0);
    }

    #[test]
    fn updates_before_the_binding_wait_for_the_launch_acknowledgement() {
        let mut subagents = Subagents::default();
        let early = child_update(
            "ses_c",
            json!({ "sessionUpdate": "tool_call", "toolCallId": "x", "name": "read" }),
        );
        assert!(subagents.child_update(early).is_empty());
        launch(&mut subagents, "t1");
        let mut ack = launched("t1", "ses_c");
        let flushed = subagents.observe_tool_update("root", &mut ack);
        assert_eq!(flushed.len(), 1);
        let replayed = subagents.child_update(flushed.into_iter().next().unwrap());
        assert_eq!(replayed[0]["params"]["update"]["parentToolCallId"], "t1");
    }

    #[test]
    fn the_acknowledged_session_id_wins_over_launch_order() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        launch(&mut subagents, "t2");
        subagents.observe_tool_update("root", &mut launched("t2", "ses_b"));
        subagents.child_status(&status("ses_a", "created"));
        subagents.child_status(&status("ses_b", "created"));
        let finished_b = subagents.child_status(&status("ses_b", "interrupted"));
        assert_eq!(finished_b[0]["params"]["update"]["toolCallId"], "t2");
        assert_eq!(
            finished_b[0]["params"]["update"]["_meta"]["cadencr"]["subagent"]["status"],
            "cancelled"
        );
        let finished_a = subagents.child_status(&json!({
            "rootSessionId": "root", "childSessionId": "ses_a", "type": "status",
            "status": "failed", "error": { "type": "x", "message": "boom" }
        }));
        assert_eq!(finished_a[0]["params"]["update"]["toolCallId"], "t1");
        assert_eq!(
            finished_a[0]["params"]["update"]["_meta"]["cadencr"]["subagent"]["summary"],
            "boom"
        );
    }

    #[test]
    fn nested_launches_bind_inside_their_child() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        subagents.observe_tool_update("root", &mut launched("t1", "ses_c"));
        let nested = subagents.child_update(child_update(
            "ses_c",
            json!({ "sessionUpdate": "tool_call", "toolCallId": "n", "name": "subagent" }),
        ));
        assert_eq!(nested[0]["params"]["update"]["toolCallId"], "ses_c:n");
        let grandchild = json!({
            "rootSessionId": "root", "childSessionId": "ses_g", "parentSessionId": "ses_c",
            "type": "status", "status": "created"
        });
        subagents.child_status(&grandchild);
        let finished = subagents.child_status(&json!({
            "rootSessionId": "root", "childSessionId": "ses_g", "type": "status", "status": "completed"
        }));
        assert_eq!(finished[0]["params"]["update"]["toolCallId"], "ses_c:n");
    }

    #[test]
    fn a_child_created_beside_another_pending_launch_waits_for_its_acknowledgement() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        launch(&mut subagents, "t2");
        assert!(subagents
            .child_status(&status("ses_b", "created"))
            .is_empty());
        let early = child_update(
            "ses_b",
            json!({ "sessionUpdate": "tool_call", "toolCallId": "x", "name": "read" }),
        );
        assert!(
            subagents.child_update(early).is_empty(),
            "not guessed by order"
        );
        let flushed = subagents.observe_tool_update("root", &mut launched("t2", "ses_b"));
        let replayed = subagents.child_update(flushed.into_iter().next().unwrap());
        assert_eq!(replayed[0]["params"]["update"]["parentToolCallId"], "t2");
    }

    #[test]
    fn text_from_a_finished_child_does_not_reopen_it() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        subagents.child_status(&status("ses_c", "created"));
        subagents.child_status(&status("ses_c", "completed"));
        subagents.child_update(child_update(
            "ses_c",
            json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "late" } }),
        ));
        assert_eq!(subagents.open_count(), 0);
    }

    #[test]
    fn updates_waiting_for_a_status_bind_reach_the_client_as_session_updates() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        launch(&mut subagents, "t2");
        subagents.child_status(&status("ses_a", "created"));
        subagents.child_update(child_update(
            "ses_a",
            json!({ "sessionUpdate": "tool_call", "toolCallId": "x", "name": "read" }),
        ));
        subagents.observe_tool_update("root", &mut launched("t2", "ses_b"));
        let replayed = subagents.child_status(&status("ses_a", "running"));
        assert_eq!(replayed.len(), 1);
        assert_eq!(replayed[0]["method"], "session/update");
        assert_eq!(replayed[0]["params"]["update"]["toolCallId"], "ses_a:x");
        assert_eq!(replayed[0]["params"]["update"]["parentToolCallId"], "t1");
    }

    #[test]
    fn a_failed_launch_does_not_block_binding_the_next_one() {
        let mut subagents = Subagents::default();
        launch(&mut subagents, "t1");
        subagents.observe_tool_update(
            "root",
            &mut json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "failed" }),
        );
        launch(&mut subagents, "t2");
        subagents.child_status(&status("ses_c", "created"));
        let finished = subagents.child_status(&status("ses_c", "completed"));
        assert_eq!(finished[0]["params"]["update"]["toolCallId"], "t2");
    }
}
