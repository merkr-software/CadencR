//! The OpenCode 2.x ACP wire, translated into the host's conventions.
//!
//! What 2.x speaks beyond standard ACP, and what the host reads instead:
//!
//! - questions arrive as `elicitation/create` forms → `AskUserQuestion`
//!   permission requests ([`questions`]);
//! - sub-agents run in the background and report through
//!   `opencode/session/child_update` → `_meta.cadencr.subagent` ([`subagents`]);
//! - a reply OpenCode produces after a prompt ended (a finished sub-agent
//!   wakes the parent) has no end marker → `detachedReplyEnded` once the
//!   session is idle in OpenCode's database ([`idle`]);
//! - file tools report a `path` relative to the session directory → the
//!   absolute `filePath` the host's renderers read.

mod idle;
mod questions;
mod subagents;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use self::questions::{parse_form, permission_request, PendingQuestion, REQUEST_ID_PREFIX};
use self::subagents::Subagents;
use crate::domain::agents::acp::wire_transform::{AcpWireTransform, WireInjector, WireRoute};

const CHILD_UPDATES_CAPABILITY: &str = "opencode/child-session-updates";
const CHILD_UPDATE_METHOD: &str = "opencode/session/child_update";

#[derive(Default)]
pub(super) struct WireState {
    /// `session/prompt` requests in flight: request id → session id.
    prompts: HashMap<String, String>,
    questions: HashMap<String, PendingQuestion>,
    next_question: u64,
    subagents: Subagents,
    pub(super) root_session: Option<String>,
    /// The hold the host keeps while sub-agents run between replies.
    pub(super) work_pending: bool,
    /// When a reply outside any prompt started streaming (ms since epoch).
    pub(super) detached_reply_since: Option<i64>,
    /// When that reply last streamed something (ms since epoch).
    pub(super) detached_reply_seen: Option<i64>,
    /// When the last sub-agent finished with no reply yet (ms since epoch).
    pub(super) settled_at: Option<i64>,
    /// The latest root context budget, restated on a synthetic usage update.
    pub(super) last_usage: Option<(Value, Value)>,
}

pub(super) struct OpenCodeV2Wire {
    state: Arc<Mutex<WireState>>,
    cwd: PathBuf,
    database: Option<PathBuf>,
}

impl OpenCodeV2Wire {
    pub(super) fn new(cwd: PathBuf, database: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(WireState::default())),
            cwd,
            database,
        }
    }

    fn with_state<R>(&self, apply: impl FnOnce(&mut WireState) -> R) -> R {
        apply(&mut lock(&self.state))
    }

    fn agent_message(&self, mut message: Value, state: &mut WireState) -> WireRoute {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        match (method.as_deref(), message.get("id").cloned()) {
            (Some("elicitation/create"), Some(id)) => self.elicitation(id, &message, state),
            (Some(CHILD_UPDATE_METHOD), None) => {
                let params = message.get_mut("params").map(Value::take);
                self.child_notification(params.unwrap_or(Value::Null), state)
            }
            (Some("session/request_permission"), Some(_)) => {
                if let Some(call) = message.pointer_mut("/params/toolCall") {
                    absolutize_file_path(call, &self.cwd);
                }
                WireRoute::to_client(message)
            }
            (Some("$/cancel_request"), None) => {
                self.withdraw_question(&mut message, state);
                WireRoute::to_client(message)
            }
            (Some("session/update"), None) => {
                let late = self.root_update(&mut message, state);
                let mut messages = vec![message];
                for params in late {
                    let mut replayed = state.subagents.child_update(params);
                    for message in &mut replayed {
                        normalize_tool_update(message.pointer_mut("/params/update"), &self.cwd);
                    }
                    messages.extend(replayed);
                }
                WireRoute {
                    to_client: messages,
                    to_agent: Vec::new(),
                }
            }
            (None, Some(id)) => {
                if let Some(session) = state.prompts.remove(&request_key(&id)) {
                    finish_prompt(&mut message, &session, state);
                }
                WireRoute::to_client(message)
            }
            _ => WireRoute::to_client(message),
        }
    }

    fn child_notification(&self, params: Value, state: &mut WireState) -> WireRoute {
        let mut messages = match params.get("type").and_then(Value::as_str) {
            Some("status") => {
                let opens = matches!(
                    params.get("status").and_then(Value::as_str),
                    Some("created" | "running")
                );
                if opens {
                    // A child launched after the others finished: the hold
                    // stays until it finishes too, including when a reply
                    // outside any prompt launched it.
                    state.settled_at = None;
                    if state.prompts.is_empty() {
                        state.work_pending = true;
                    }
                }
                state.subagents.child_status(&params)
            }
            Some("update") => state.subagents.child_update(params),
            _ => Vec::new(),
        };
        for message in &mut messages {
            normalize_tool_update(message.pointer_mut("/params/update"), &self.cwd);
        }
        if state.subagents.open_count() == 0 && state.work_pending {
            state.settled_at.get_or_insert_with(now_millis);
        }
        WireRoute {
            to_client: messages,
            to_agent: Vec::new(),
        }
    }

    /// OpenCode withdrew an elicitation (the turn was cancelled): point the
    /// cancellation at the permission id the host knows and forget it.
    fn withdraw_question(&self, message: &mut Value, state: &mut WireState) {
        let Some(request_id) = message.pointer("/params/requestId").cloned() else {
            return;
        };
        let minted = state
            .questions
            .iter()
            .find(|(_, question)| question.agent_request_id == request_id)
            .map(|(key, _)| key.clone());
        if let Some(minted) = minted {
            state.questions.remove(&minted);
            if let Ok(id) = serde_json::from_str::<Value>(&minted) {
                message["params"]["requestId"] = id;
            }
        }
    }

    /// Returns child updates that waited for the launch this update binds.
    fn root_update(&self, message: &mut Value, state: &mut WireState) -> Vec<Value> {
        let session = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(update) = message.pointer_mut("/params/update") else {
            return Vec::new();
        };
        normalize_tool_update(Some(update), &self.cwd);
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        if kind == Some("usage_update") {
            if let (Some(used), Some(size)) = (update.get("used"), update.get("size")) {
                state.last_usage = Some((used.clone(), size.clone()));
            }
        }
        let streams_reply = matches!(
            kind,
            Some("agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update")
        );
        if streams_reply && state.prompts.is_empty() {
            let now = now_millis();
            state.detached_reply_since.get_or_insert(now);
            state.detached_reply_seen = Some(now);
        }
        match session {
            Some(session) => state.subagents.observe_tool_update(&session, update),
            None => Vec::new(),
        }
    }

    fn elicitation(&self, id: Value, message: &Value, state: &mut WireState) -> WireRoute {
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let Some(fields) = parse_form(&params) else {
            return WireRoute::to_agent(json!({
                "jsonrpc": "2.0", "id": id, "result": { "action": "cancel" }
            }));
        };
        let request_id = format!("{REQUEST_ID_PREFIX}{}", state.next_question);
        state.next_question += 1;
        let tool_call_id = params
            .get("toolCallId")
            .and_then(Value::as_str)
            .map_or_else(|| request_id.clone(), str::to_owned);
        let request = permission_request(&request_id, &params, &fields, &tool_call_id);
        state.questions.insert(
            request_key(&Value::String(request_id)),
            PendingQuestion::new(id, fields),
        );
        WireRoute::to_client(request)
    }

    fn client_message(&self, mut message: Value, state: &mut WireState) -> WireRoute {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id = message.get("id").cloned();
        match (method.as_deref(), id) {
            (Some("initialize"), _) => {
                let capabilities = &mut message["params"]["clientCapabilities"];
                capabilities["elicitation"]["form"] = json!({});
                capabilities["_meta"][CHILD_UPDATES_CAPABILITY] = Value::Bool(true);
            }
            (Some("session/prompt"), Some(id)) => {
                if let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    state.root_session = Some(session.to_owned());
                    state.prompts.insert(request_key(&id), session.to_owned());
                }
                state.detached_reply_since = None;
                state.detached_reply_seen = None;
            }
            (None, Some(id)) => {
                if let Some(question) = state.questions.remove(&request_key(&id)) {
                    return WireRoute::to_agent(question.response(message.get("result")));
                }
            }
            _ => {}
        }
        WireRoute::to_agent(message)
    }
}

/// Hold the conversation working when the prompt ends with sub-agents running.
fn finish_prompt(response: &mut Value, session: &str, state: &mut WireState) {
    state.root_session = Some(session.to_owned());
    let ended = response
        .pointer("/result/stopReason")
        .and_then(Value::as_str)
        == Some("end_turn");
    if ended && state.subagents.open_count() > 0 {
        response["result"]["_meta"]["cadencr"]["backgroundWorkPending"] = Value::Bool(true);
        state.work_pending = true;
        state.settled_at = None;
    }
}

impl AcpWireTransform for OpenCodeV2Wire {
    fn agent_wrote(&self, message: Value) -> WireRoute {
        self.with_state(|state| self.agent_message(message, state))
    }

    fn client_wrote(&self, message: Value) -> WireRoute {
        self.with_state(|state| self.client_message(message, state))
    }

    fn start(&self, injector: WireInjector) {
        if let Some(database) = &self.database {
            idle::spawn_watcher(Arc::downgrade(&self.state), database.clone(), injector);
        }
    }
}

/// Give a 2.x tool update the shape 1.x sent: the tool's text output in
/// `rawOutput.output` (2.x keeps only `metadata` there and the text in
/// `content`), and an absolute `filePath` for file tools.
fn normalize_tool_update(update: Option<&mut Value>, cwd: &std::path::Path) {
    let Some(update) = update else {
        return;
    };
    fill_raw_output_text(update);
    absolutize_file_path(update, cwd);
}

fn fill_raw_output_text(update: &mut Value) {
    let Some(raw_output) = update.get("rawOutput").and_then(Value::as_object) else {
        return;
    };
    if raw_output.contains_key("output") {
        return;
    }
    let text: Vec<&str> = update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|block| block.pointer("/content/text").and_then(Value::as_str))
        .collect();
    if text.is_empty() {
        return;
    }
    update["rawOutput"]["output"] = Value::String(text.join("\n"));
}

/// 2.x file tools (`read`, `write`, `edit`) give `path` relative to the
/// session directory; the host reads the absolute `filePath` 1.x sent. Search
/// tools keep their `path` (a directory to search).
fn absolutize_file_path(update: &mut Value, cwd: &std::path::Path) {
    if !matches!(
        update.get("kind").and_then(Value::as_str),
        Some("read" | "edit")
    ) {
        return;
    }
    let Some(input) = update.get_mut("rawInput").and_then(Value::as_object_mut) else {
        return;
    };
    if input.contains_key("filePath") {
        return;
    }
    let Some(Value::String(path)) = input.remove("path") else {
        return;
    };
    let absolute = cwd.join(path);
    input.insert(
        "filePath".to_owned(),
        Value::String(absolute.to_string_lossy().into_owned()),
    );
}

fn request_key(id: &Value) -> String {
    id.to_string()
}

pub(super) fn lock(state: &Mutex<WireState>) -> std::sync::MutexGuard<'_, WireState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A `session/update` notification for `session` (a session id, or null).
pub(super) fn session_update(session: Value, update: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": { "sessionId": session, "update": update },
    })
}

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::OpenCodeV2Wire;
    use crate::domain::agents::acp::wire_transform::AcpWireTransform;
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn wire() -> OpenCodeV2Wire {
        OpenCodeV2Wire::new(PathBuf::from("/repo"), None)
    }

    fn only_client(route: crate::domain::agents::acp::wire_transform::WireRoute) -> Value {
        assert!(route.to_agent.is_empty(), "{route:?}");
        assert_eq!(route.to_client.len(), 1, "{route:?}");
        route.to_client.into_iter().next().unwrap()
    }

    fn only_agent(route: crate::domain::agents::acp::wire_transform::WireRoute) -> Value {
        assert!(route.to_client.is_empty(), "{route:?}");
        assert_eq!(route.to_agent.len(), 1, "{route:?}");
        route.to_agent.into_iter().next().unwrap()
    }

    #[test]
    fn initialize_asks_for_forms_and_child_session_updates() {
        let sent = only_agent(wire().client_wrote(json!({
            "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": 1, "clientCapabilities": { "terminal": true } }
        })));
        let capabilities = &sent["params"]["clientCapabilities"];
        assert_eq!(capabilities["terminal"], true);
        assert_eq!(capabilities["elicitation"], json!({ "form": {} }));
        assert_eq!(
            capabilities["_meta"]["opencode/child-session-updates"],
            true
        );
    }

    #[test]
    fn a_question_round_trips_through_the_permission_drawer() {
        let wire = wire();
        let request = only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "id": 9, "method": "elicitation/create",
            "params": {
                "mode": "form", "sessionId": "ses_1", "toolCallId": "toolu_q",
                "requestedSchema": { "properties": { "q0": {
                    "type": "string", "description": "Color?",
                    "oneOf": [{ "const": "Red", "title": "Red" }]
                } } }
            }
        })));
        assert_eq!(request["method"], "session/request_permission");
        let reply = only_agent(wire.client_wrote(json!({
            "jsonrpc": "2.0", "id": request["id"],
            "result": {
                "outcome": { "outcome": "selected", "optionId": "answer" },
                "_meta": { "updatedInput": { "answers": { "Color?": "Red" } } }
            }
        })));
        assert_eq!(
            reply,
            json!({ "jsonrpc": "2.0", "id": 9, "result": { "action": "accept", "content": { "q0": "Red" } } })
        );
    }

    #[test]
    fn a_prompt_ending_with_running_children_holds_the_conversation() {
        let wire = wire();
        only_agent(wire.client_wrote(json!({
            "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
            "params": { "sessionId": "root", "prompt": [] }
        })));
        only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "root",
                "update": { "sessionUpdate": "tool_call", "toolCallId": "t1", "name": "subagent" } }
        })));
        wire.agent_wrote(json!({
            "jsonrpc": "2.0", "method": "opencode/session/child_update",
            "params": { "rootSessionId": "root", "childSessionId": "c", "parentSessionId": "root",
                "type": "status", "status": "created" }
        }));
        let response = only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "end_turn" }
        })));
        assert_eq!(
            response["result"]["_meta"]["cadencr"]["backgroundWorkPending"],
            true
        );
        let after = only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "root",
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } }
        })));
        assert_eq!(
            after["params"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );
        wire.with_state(|state| {
            assert!(state.work_pending);
            assert!(state.detached_reply_since.is_some());
        });
    }

    #[test]
    fn relative_file_paths_become_absolute() {
        let update = only_client(wire().agent_wrote(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "root",
                "update": { "sessionUpdate": "tool_call_update", "toolCallId": "r", "kind": "read",
                    "rawInput": { "path": "src/a.rs" } } }
        })));
        assert_eq!(
            update["params"]["update"]["rawInput"],
            json!({ "filePath": "/repo/src/a.rs" })
        );
        let search = only_client(wire().agent_wrote(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "root",
                "update": { "sessionUpdate": "tool_call_update", "toolCallId": "g", "kind": "search",
                    "rawInput": { "pattern": "x", "path": "src" } } }
        })));
        assert_eq!(search["params"]["update"]["rawInput"]["path"], "src");
    }

    #[test]
    fn tool_text_output_rides_raw_output_like_v1() {
        let update = only_client(wire().agent_wrote(json!({
            "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": "root",
                "update": { "sessionUpdate": "tool_call_update", "toolCallId": "s", "status": "completed",
                    "content": [{ "type": "content", "content": { "type": "text", "text": "README.md" } },
                                { "type": "diff", "path": "/repo/a", "oldText": "", "newText": "x" }],
                    "rawOutput": { "metadata": { "exit": 0 } } } }
        })));
        assert_eq!(
            update["params"]["update"]["rawOutput"],
            json!({ "metadata": { "exit": 0 }, "output": "README.md" })
        );
    }

    fn child_status(wire: &OpenCodeV2Wire, child: &str, status: &str) {
        wire.agent_wrote(json!({
            "jsonrpc": "2.0", "method": "opencode/session/child_update",
            "params": { "rootSessionId": "root", "childSessionId": child, "parentSessionId": "root",
                "type": "status", "status": status }
        }));
    }

    #[test]
    fn a_child_launched_after_the_others_finished_keeps_the_hold() {
        let wire = wire();
        wire.with_state(|state| state.work_pending = true);
        child_status(&wire, "a", "created");
        child_status(&wire, "a", "completed");
        wire.with_state(|state| assert!(state.settled_at.is_some()));
        child_status(&wire, "b", "created");
        wire.with_state(|state| {
            assert!(state.settled_at.is_none(), "b still runs");
            assert!(state.work_pending);
        });
    }

    #[test]
    fn a_withdrawn_question_cancels_the_permission_id_the_host_knows() {
        let wire = wire();
        let request = only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "id": 9, "method": "elicitation/create",
            "params": { "mode": "form", "sessionId": "ses_1",
                "requestedSchema": { "properties": { "q0": { "type": "string", "title": "Name" } } } }
        })));
        let cancel = only_client(wire.agent_wrote(json!({
            "jsonrpc": "2.0", "method": "$/cancel_request", "params": { "requestId": 9 }
        })));
        assert_eq!(cancel["params"]["requestId"], request["id"]);
        wire.with_state(|state| assert!(state.questions.is_empty()));
    }

    #[test]
    fn a_permission_request_shows_the_absolute_file_path() {
        let request = only_client(wire().agent_wrote(json!({
            "jsonrpc": "2.0", "id": 4, "method": "session/request_permission",
            "params": { "sessionId": "root", "toolCall": { "toolCallId": "e", "kind": "edit",
                "rawInput": { "path": "src/a.rs" } }, "options": [] }
        })));
        assert_eq!(
            request["params"]["toolCall"]["rawInput"],
            json!({ "filePath": "/repo/src/a.rs" })
        );
    }
}
