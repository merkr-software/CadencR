//! Rewrite Cursor tool calls so the standard ACP `name` carries Cadencr's
//! canonical tool name and `rawInput` uses canonical keys.
//!
//! Cadencr's ACP runtime resolves a tool name from `toolName`, then `name`,
//! then `kind`/`title`; installed providers get no further normalization, so
//! the connector applies the hint order the built-in Cursor adapter relied on
//! and writes the result into `name`.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::extensions::task::repair_agent_completion;
use crate::normalize::{canonical_tool_name, derive_permission_tool_input, normalize_tool_input};

/// Canonical names recorded per `toolCallId`, so updates without metadata
/// keep the start's name and late Cursor extensions find their call.
#[derive(Debug, Default)]
pub struct ToolNames(HashMap<String, String>);

impl ToolNames {
    pub fn get(&self, tool_call_id: &str) -> Option<&str> {
        self.0.get(tool_call_id).map(String::as_str)
    }

    pub fn record(&mut self, tool_call_id: &str, name: &str) {
        self.0.insert(tool_call_id.to_string(), name.to_string());
    }
}

/// Port of the host resolver's hint order, without its `"tool"` fallback.
fn name_hint(body: &Map<String, Value>) -> Option<String> {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let title = text("title");
    let literal_task = title
        .filter(|title| title.eq_ignore_ascii_case("task") || title.eq_ignore_ascii_case("agent"));
    let subagent_input = body
        .get("rawInput")
        .and_then(|input| input.get("subagent_type"))
        .and_then(Value::as_str)
        .map(|_| "task");
    let hint = text("toolName")
        .or_else(|| text("name"))
        .or(subagent_input)
        .or(literal_task)
        .or_else(|| kind_name(body.get("kind").and_then(Value::as_str)))
        .or(title)?;
    Some(canonical_tool_name(hint))
}

fn kind_name(kind: Option<&str>) -> Option<&'static str> {
    Some(match kind? {
        "read" => "Read",
        "edit" => "Edit",
        "delete" => "Delete",
        "move" => "Move",
        "search" => "Search",
        "execute" => "Bash",
        "think" => "Think",
        "fetch" => "Fetch",
        "switch_mode" => "SwitchMode",
        _ => return None,
    })
}

/// A later, more specific hint wins over the recorded one only where the
/// start was a known placeholder (`Think` before Task input lands, Cursor's
/// generic `MCP: tool` before the permission names the server).
fn upgraded(recorded: &str, resolved: &str) -> bool {
    (recorded == "Think" && resolved == "Agent")
        || (recorded == "mcp__mcp__tool" && resolved.starts_with("mcp__") && resolved != recorded)
}

/// Rewrite a `tool_call` / `tool_call_update` update object in place.
pub fn rewrite_tool_update(update: &mut Map<String, Value>, names: &mut ToolNames) {
    let Some(id) = update
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return;
    };
    let is_start = update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call");
    let resolved = name_hint(update);
    let name = match (names.get(&id), resolved) {
        (Some(recorded), Some(resolved)) if !is_start && !upgraded(recorded, &resolved) => {
            recorded.to_string()
        }
        (_, Some(resolved)) => resolved,
        (Some(recorded), None) => recorded.to_string(),
        (None, None) if is_start => "tool".to_string(),
        (None, None) => return,
    };
    names.record(&id, &name);
    update.insert("name".to_string(), Value::String(name.clone()));
    normalize_raw_input(update, &name);
    if name == "Agent" {
        repair_agent_completion(update);
    }
}

fn normalize_raw_input(object: &mut Map<String, Value>, name: &str) {
    for key in ["rawInput", "toolInput"] {
        if let Some(input) = object.remove(key) {
            object.insert(key.to_string(), normalize_tool_input(name, input));
        }
    }
}

/// Rewrite `session/request_permission` params: canonical `name`/`toolName`
/// and canonical input (MCP arguments recovered from the permission text).
pub fn rewrite_permission_params(params: &mut Value, names: &mut ToolNames) {
    let snapshot = params.clone();
    let Some(tool_call) = params.get_mut("toolCall").and_then(Value::as_object_mut) else {
        return;
    };
    let id = tool_call
        .get("toolCallId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let recorded = id
        .as_deref()
        .and_then(|id| names.get(id))
        .map(ToOwned::to_owned);
    let resolved = name_hint(tool_call);
    let name = match (recorded, resolved) {
        (Some(recorded), Some(resolved)) if !upgraded(&recorded, &resolved) => recorded,
        (_, Some(resolved)) => resolved,
        (Some(recorded), None) => recorded,
        (None, None) => return,
    };
    if let Some(id) = id.as_deref() {
        names.record(id, &name);
    }
    let raw = tool_call
        .get("rawInput")
        .or_else(|| tool_call.get("toolInput"))
        .cloned()
        .unwrap_or(Value::Null);
    let derived = derive_permission_tool_input(&name, raw, &snapshot);
    if !derived.is_null() {
        tool_call.insert("rawInput".to_string(), normalize_tool_input(&name, derived));
        tool_call.remove("toolInput");
    }
    tool_call.insert("name".to_string(), Value::String(name.clone()));
    tool_call.insert("toolName".to_string(), Value::String(name));
}

#[cfg(test)]
mod tests {
    use super::{rewrite_permission_params, rewrite_tool_update, ToolNames};
    use serde_json::{json, Map, Value};

    fn rewrite(names: &mut ToolNames, value: Value) -> Map<String, Value> {
        let mut update = value.as_object().unwrap().clone();
        rewrite_tool_update(&mut update, names);
        update
    }

    #[test]
    fn canonical_names_follow_cursor_hints() {
        let mut names = ToolNames::default();
        let bash = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "t1",
                "title": "`git status`", "kind": "execute", "rawInput": { "command": "git status" }
            }),
        );
        assert_eq!(bash["name"], "Bash");
        let task = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "t2",
                "title": "Task: Subagent task", "kind": "other", "rawInput": { "_toolName": "task" }
            }),
        );
        assert_eq!(task["name"], "Agent");
        let mcp = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "t3", "title": "MCP: tool", "kind": "other"
            }),
        );
        assert_eq!(mcp["name"], "mcp__mcp__tool");
        let unknown = rewrite(
            &mut names,
            json!({ "sessionUpdate": "tool_call", "toolCallId": "t4" }),
        );
        assert_eq!(unknown["name"], "tool");
    }

    #[test]
    fn updates_keep_the_recorded_name_and_normalize_input() {
        let mut names = ToolNames::default();
        rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "w1", "toolName": "write_file", "kind": "edit"
            }),
        );
        let update = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "w1", "kind": "edit",
                "rawInput": { "path": "a.rs", "fileText": "x" }
            }),
        );
        assert_eq!(update["name"], "Write");
        assert_eq!(
            update["rawInput"],
            json!({ "file_path": "a.rs", "content": "x" })
        );
        let bare = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "w1", "status": "completed"
            }),
        );
        assert_eq!(bare["name"], "Write");
        let untracked = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "zz", "status": "completed"
            }),
        );
        assert!(untracked.get("name").is_none());
    }

    #[test]
    fn agent_failures_become_failed_updates() {
        let mut names = ToolNames::default();
        rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "a1", "title": "Task: Explore", "kind": "other"
            }),
        );
        let done = rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "a1", "status": "completed",
                "rawOutput": { "error": "usage limit" }
            }),
        );
        assert_eq!(done["name"], "Agent");
        assert_eq!(done["status"], "failed");
    }

    #[test]
    fn permissions_reveal_mcp_identity_and_keep_shell_names() {
        let mut names = ToolNames::default();
        rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "m1", "title": "MCP: tool", "kind": "other"
            }),
        );
        let mut params = json!({
            "toolCall": {
                "toolCallId": "m1",
                "title": "probe-server-echo_probe: echo_probe",
                "kind": "other",
                "content": [{ "type": "content", "content": { "type": "text", "text": "{\"text\":\"hi\"}" } }]
            }
        });
        rewrite_permission_params(&mut params, &mut names);
        assert_eq!(
            params["toolCall"]["toolName"],
            "mcp__probe-server__echo_probe"
        );
        assert_eq!(params["toolCall"]["name"], "mcp__probe-server__echo_probe");
        assert_eq!(
            params["toolCall"]["rawInput"],
            json!({ "server": "probe-server", "tool": "echo_probe", "arguments": { "text": "hi" } })
        );
        assert_eq!(names.get("m1"), Some("mcp__probe-server__echo_probe"));

        rewrite(
            &mut names,
            json!({
                "sessionUpdate": "tool_call", "toolCallId": "s1", "title": "`pwd`", "kind": "execute"
            }),
        );
        let mut shell =
            json!({ "toolCall": { "toolCallId": "s1", "title": "`pwd`", "kind": "execute" } });
        rewrite_permission_params(&mut shell, &mut names);
        assert_eq!(shell["toolCall"]["toolName"], "Bash");
        assert!(shell["toolCall"].get("rawInput").is_none());
    }
}
