//! Messages from `agent acp`: session updates are normalized in reader order;
//! Cursor extensions become standard ACP; everything else is forwarded.

use std::sync::Arc;

use serde_json::{json, Value};

use super::child::ChildConn;
use super::rpc::{classify, Incoming};
use super::state::ProxyState;
use super::{session_id_of, Proxy};
use crate::extensions::task::task_input;
use crate::extensions::todos::plan_update;
use crate::extensions::tool_call_id;
use crate::permission_policy::automatic_allow_option;
use crate::tool_calls::{rewrite_permission_params, rewrite_tool_update};

impl Proxy {
    pub(super) fn handle_child_message(self: &Arc<Self>, conn: &Arc<ChildConn>, message: Value) {
        match classify(message) {
            Incoming::Response(response) => conn.peer.resolve(&response),
            Incoming::Notification { method, params } => match method.as_str() {
                "session/update" => self.forward_session_update(params),
                "cursor/update_todos" | "cursor/task" | "cursor/generate_image" => {
                    self.cursor_notification(&method, &params);
                }
                _ => self.host.notify(&method, params),
            },
            Incoming::Request { id, method, params } => {
                self.child_request(conn, id, method, params)
            }
            Incoming::Invalid => eprintln!("cursor connector: ignored a malformed Cursor frame"),
        }
    }

    fn child_request(
        self: &Arc<Self>,
        conn: &Arc<ChildConn>,
        id: Value,
        method: String,
        params: Value,
    ) {
        let proxy = Arc::clone(self);
        let conn = Arc::clone(conn);
        match method.as_str() {
            "session/request_permission" => {
                tokio::spawn(async move { proxy.permission(conn, id, params).await });
            }
            "cursor/ask_question" => {
                tokio::spawn(async move { proxy.ask_question(conn, id, params).await });
            }
            "cursor/create_plan" => {
                tokio::spawn(async move { proxy.create_plan(conn, id, params).await });
            }
            "cursor/update_todos" | "cursor/task" | "cursor/generate_image" => {
                self.cursor_notification(&method, &params);
                conn.peer.respond(id, Ok(json!({})));
            }
            _ => self.passthrough_to_host(&conn, id, &method, params),
        }
    }

    fn forward_session_update(&self, mut params: Value) {
        let Some(session_id) = session_id_of(&params) else {
            self.host.notify("session/update", params);
            return;
        };
        let kind = params
            .pointer("/update/sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if self.subagent_update(&session_id, &kind, &mut params) {
            return;
        }
        {
            let mut state = self.state();
            if state.suppressed.contains(&session_id) {
                return;
            }
            let ProxyState {
                tools, sessions, ..
            } = &mut *state;
            let update = params.get_mut("update").and_then(Value::as_object_mut);
            match (kind.as_str(), update) {
                ("tool_call" | "tool_call_update", Some(update)) => {
                    rewrite_tool_update(update, tools);
                    let is_todo = update.get("name").and_then(Value::as_str) == Some("TodoWrite");
                    if let (true, Some(session)) = (is_todo, sessions.get_mut(&session_id)) {
                        session.todos.rewrite_tool_input(update);
                    }
                }
                ("available_commands_update", Some(update)) => {
                    crate::slash_commands::normalize_live_update(update)
                }
                ("current_mode_update", Some(update)) => {
                    if let (Some(mode), Some(session)) = (
                        update.get("currentModeId").cloned(),
                        sessions.get_mut(&session_id),
                    ) {
                        session.config.set_current("mode", mode);
                    }
                }
                _ => {}
            }
        }
        if kind == "config_option_update" {
            self.rewrite_config_update(&session_id, &mut params);
        }
        self.host.notify("session/update", params);
    }

    /// Fold Cursor's (complete or legacy single-option) update into the
    /// session and publish the complete host view instead.
    fn rewrite_config_update(&self, session_id: &str, params: &mut Value) {
        let Some(update) = params.get_mut("update").and_then(Value::as_object_mut) else {
            return;
        };
        if let Some(options) = update
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
        {
            if let Some(session) = self.state().sessions.get_mut(session_id) {
                session.config.observe(&options);
            }
        } else if let Some(option) = update.remove("configOption") {
            let id = option
                .get("id")
                .or_else(|| option.get("name"))
                .and_then(Value::as_str);
            if let (Some(id), Some(value)) = (id, option.get("value")) {
                self.record_child_value(session_id, id, value.clone());
            }
        }
        update.insert(
            "configOptions".to_string(),
            Value::Array(self.host_options(session_id)),
        );
    }

    async fn permission(self: Arc<Self>, conn: Arc<ChildConn>, id: Value, mut params: Value) {
        let (access, launched) = {
            let state = self.state();
            (state.access, state.child_access)
        };
        if let Some(option_id) = automatic_allow_option(access, launched, &params) {
            let outcome = json!({ "outcome": { "outcome": "selected", "optionId": option_id } });
            conn.peer.respond(id, Ok(outcome));
            return;
        }
        rewrite_permission_params(&mut params, &mut self.state().tools);
        let result = self
            .host
            .request("session/request_permission", params)
            .await;
        conn.peer.respond(id, result);
    }

    /// `cursor/update_todos` → `plan`; `cursor/task` / `cursor/generate_image`
    /// → the matching `Agent` / `GenerateImage` tool call. A sub-agent's
    /// calls are nested under its launching call; its todos are dropped.
    fn cursor_notification(&self, method: &str, params: &Value) {
        let session_id = self.state().session_for(params);
        let child = session_id.and_then(|session_id| self.subagent_parent(&session_id));
        if child.is_some() && method == "cursor/update_todos" {
            return;
        }
        let routed = {
            let mut state = self.state();
            state.session_for(params).map(|session_id| {
                let mut update = match method {
                    "cursor/update_todos" => match state.sessions.get_mut(&session_id) {
                        Some(session) => plan_update(&session.todos.merge(params)),
                        None => plan_update(params),
                    },
                    "cursor/task" => extension_tool_update(
                        &mut state,
                        params,
                        "Agent",
                        task_title(params),
                        task_input(params),
                    ),
                    _ => extension_tool_update(
                        &mut state,
                        params,
                        "GenerateImage",
                        "Generate image".to_string(),
                        params.clone(),
                    ),
                };
                match child {
                    Some((parent, tool_call_id)) => {
                        update["parentToolCallId"] = json!(tool_call_id);
                        (parent, update)
                    }
                    None => (session_id, update),
                }
            })
        };
        match routed {
            Some((session_id, update)) => self.host.notify(
                "session/update",
                json!({ "sessionId": session_id, "update": update }),
            ),
            None => eprintln!("cursor connector: `{method}` arrived before any session existed"),
        }
    }
}

fn task_title(params: &Value) -> String {
    params
        .get("description")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or("Task")
        .to_string()
}

/// Update the call Cursor already announced, or announce a finished one.
fn extension_tool_update(
    state: &mut ProxyState,
    params: &Value,
    name: &str,
    title: String,
    input: Value,
) -> Value {
    let known = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| state.tools.get(id).is_some())
        .map(ToOwned::to_owned);
    if let Some(id) = known {
        state.tools.record(&id, name);
        return json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": id,
            "name": name,
            "rawInput": input,
        });
    }
    let id = tool_call_id(params, || state.synthetic_id("tool"));
    state.tools.record(&id, name);
    json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "name": name,
        "title": title,
        "kind": "other",
        "status": "completed",
        "rawInput": input,
    })
}

#[cfg(test)]
mod tests {
    use super::{extension_tool_update, task_title};
    use crate::proxy::state::ProxyState;
    use serde_json::json;

    #[test]
    fn extensions_update_known_calls_and_announce_unknown_ones() {
        let mut state = ProxyState::default();
        state.tools.record("task-1", "Agent");
        let known = extension_tool_update(
            &mut state,
            &json!({ "toolCallId": "task-1" }),
            "Agent",
            "Task".into(),
            json!({ "model": "composer-2.5" }),
        );
        assert_eq!(known["sessionUpdate"], "tool_call_update");
        assert_eq!(known["name"], "Agent");
        assert_eq!(known["rawInput"]["model"], "composer-2.5");

        let fresh = extension_tool_update(
            &mut state,
            &json!({ "prompt": "draw" }),
            "GenerateImage",
            "Generate image".into(),
            json!({ "prompt": "draw" }),
        );
        assert_eq!(fresh["sessionUpdate"], "tool_call");
        assert_eq!(fresh["status"], "completed");
        assert!(fresh["toolCallId"]
            .as_str()
            .unwrap()
            .starts_with("cursor-tool-"));
        assert_eq!(task_title(&json!({ "description": "Explore" })), "Explore");
        assert_eq!(task_title(&json!({})), "Task");
    }
}
