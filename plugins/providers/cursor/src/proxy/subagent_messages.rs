//! Cursor sub-agent frames: `subagent_spawned` / `subagent_state_update` on
//! the parent session and the child session's own updates (see
//! `extensions/subagents.rs`).

use serde_json::{json, Value};

use super::state::ProxyState;
use super::Proxy;
use crate::extensions::subagents::{is_child_todo_update, nest_child_tool_update};
use crate::tool_calls::rewrite_tool_update;

impl Proxy {
    /// Handle a sub-agent `session/update`; `false` leaves it to the caller.
    pub(super) fn subagent_update(&self, session_id: &str, kind: &str, params: &mut Value) -> bool {
        let forwarded = {
            let mut state = self.state();
            let ProxyState {
                tools, subagents, ..
            } = &mut *state;
            let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
                return false;
            };
            match kind {
                "subagent_spawned" => {
                    subagents.spawned(session_id, update);
                    return true;
                }
                "subagent_state_update" => subagents.finished(update).map(|(parent, finished)| {
                    let parent = parent.unwrap_or_else(|| session_id.to_string());
                    json!({ "sessionId": parent, "update": finished })
                }),
                _ if subagents.link(session_id).is_none() => return false,
                // The child's text becomes the run's summary.
                "agent_message_chunk" => {
                    subagents.record_text(session_id, update);
                    None
                }
                "tool_call" | "tool_call_update" => {
                    rewrite_tool_update(update, tools);
                    // Like its plans, the child's todo list would replace the
                    // parent's.
                    if is_child_todo_update(update) {
                        return true;
                    }
                    let Some(link) = subagents.link(session_id) else {
                        return true;
                    };
                    nest_child_tool_update(update, link);
                    let parent = link.parent_session.clone();
                    let mut nested = params.take();
                    nested["sessionId"] = json!(parent);
                    Some(nested)
                }
                // Its other updates (plans, commands) would overwrite the
                // parent's.
                _ => None,
            }
        };
        if let Some(params) = forwarded {
            self.host.notify("session/update", params);
        }
        true
    }

    /// The parent session and launching call of a sub-agent session.
    pub(super) fn subagent_parent(&self, session_id: &str) -> Option<(String, String)> {
        self.state()
            .subagents
            .link(session_id)
            .map(|link| (link.parent_session.clone(), link.tool_call_id.clone()))
    }
}
