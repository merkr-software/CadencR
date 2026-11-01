//! Cursor tool names and inputs → Cadencr's canonical tool vocabulary.
//!
//! The host's generic installed-provider adapter does no tool normalization,
//! so the connector rewrites names (ACP `ToolCall.name`) and `rawInput` keys
//! before they leave the proxy.

use serde_json::{json, Map, Value};

pub fn canonical_tool_name(raw: &str) -> String {
    if let Some(name) = canonical_mcp_tool_name(raw) {
        return name;
    }
    if is_task_title(raw) {
        return "Agent".to_string();
    }
    let canonical = match raw
        .to_ascii_lowercase()
        .replace(['-', '_', ' '], "")
        .as_str()
    {
        "bash" | "shell" | "terminal" | "shelltoolcall" => "Bash",
        "read" | "readfile" | "readtoolcall" => "Read",
        "ls" | "list" | "listfiles" => "LS",
        "glob" | "findfiles" => "Glob",
        "grep" | "search" | "searchfiles" | "searchcode" => "Search",
        "write" | "writefile" | "writetoolcall" => "Write",
        "edit" | "editfile" | "edittoolcall" => "Edit",
        "applypatch" => "ApplyPatch",
        "delete" | "deletefile" => "Delete",
        "move" | "movefile" | "rename" | "renamefile" => "Move",
        "think" => "Think",
        "fetch" => "Fetch",
        "switchmode" => "SwitchMode",
        "websearch" => "WebSearch",
        "webfetch" => "WebFetch",
        "generateimage" => "GenerateImage",
        "todo" | "todowrite" | "updatetodos" => "TodoWrite",
        "task" | "agent" => "Agent",
        "askquestion" | "askuserquestion" => "AskUserQuestion",
        // Cursor's native plan call shares its `toolCallId` with the
        // `cursor/create_plan` gate, so it must carry the gate's name or its
        // updates rename the transcript's plan card.
        "createplan" => "ExitPlanMode",
        _ => return raw.to_string(),
    };
    canonical.to_string()
}

/// Cursor's ACP bridge does not expose a stable MCP `toolName`. The initial
/// tool call is titled `MCP: tool`, while its permission request later uses
/// `<server>-<tool>: <tool>`. Both become the canonical `mcp__server__tool`
/// namespace. The generic `mcp` placeholder is deliberately not named
/// `cursor`: Cursor is the agent provider, not the MCP server.
fn canonical_mcp_tool_name(raw: &str) -> Option<String> {
    if raw.trim().eq_ignore_ascii_case("MCP: tool") {
        return Some("mcp__mcp__tool".to_string());
    }
    let (qualified, tool) = raw.rsplit_once(':')?;
    let qualified = qualified.trim();
    let tool = tool.trim();
    if qualified.is_empty() || tool.is_empty() {
        return None;
    }
    let prefix = qualified.strip_suffix(tool)?.trim_end();
    let server = prefix.strip_suffix(['-', '_'])?.trim();
    if server.is_empty() {
        return None;
    }
    Some(format!("mcp__{server}__{tool}"))
}

fn is_task_title(raw: &str) -> bool {
    raw.split_once(':')
        .is_some_and(|(kind, _)| kind.trim().eq_ignore_ascii_case("task"))
}

pub fn normalize_tool_input(tool_name: &str, input: Value) -> Value {
    if canonical_mcp_identity(tool_name).is_some() {
        return normalize_mcp_input(tool_name, input);
    }
    let mut input = normalize_edit_input(tool_name, input);
    if let (Value::Object(object), "Write") = (&mut input, tool_name) {
        rename_key(object, "fileText", "content");
    }
    input
}

/// Normalize ACP edit-tool fields into the shape the desktop renderers read.
fn normalize_edit_input(tool_name: &str, mut input: Value) -> Value {
    if !matches!(tool_name, "Edit" | "MultiEdit" | "Write" | "ApplyPatch") {
        return input;
    }
    let Some(map) = input.as_object_mut() else {
        return input;
    };
    rename_key(map, "filePath", "file_path");
    rename_key(map, "path", "file_path");
    if tool_name == "Write" {
        rename_key(map, "newText", "content");
        map.remove("oldText");
    } else {
        rename_key(map, "oldText", "old_string");
        rename_key(map, "newText", "new_string");
    }
    input
}

fn rename_key(map: &mut Map<String, Value>, from: &str, to: &str) {
    if map.contains_key(to) {
        return;
    }
    if let Some(value) = map.remove(from) {
        map.insert(to.to_string(), value);
    }
}

fn normalize_mcp_input(tool_name: &str, input: Value) -> Value {
    let Some((server, tool)) = canonical_mcp_identity(tool_name) else {
        return input;
    };
    if server == "mcp" && tool == "tool" {
        return input;
    }
    if input.get("server").and_then(Value::as_str).is_some()
        && input.get("tool").and_then(Value::as_str).is_some()
    {
        return input;
    }
    let arguments = match strip_cursor_placeholder(input) {
        Value::Null => json!({}),
        other => other,
    };
    json!({ "server": server, "tool": tool, "arguments": arguments })
}

pub fn derive_permission_tool_input(tool_name: &str, input: Value, params: &Value) -> Value {
    if !tool_name.starts_with("mcp__") || has_explicit_permission_input(&input) {
        return input;
    }
    mcp_input_from_permission_content(params).unwrap_or(input)
}

fn has_explicit_permission_input(input: &Value) -> bool {
    match input {
        Value::Null => false,
        Value::Object(object) => object
            .keys()
            .any(|key| !matches!(key.as_str(), "description" | "locations" | "path" | "line")),
        _ => true,
    }
}

/// Cursor puts ordinary MCP arguments in a single JSON text block instead of
/// ACP `rawInput`. Requiring that one structured block also keeps Auto Review
/// fail-closed for unknown policy or safety messages.
pub fn mcp_input_from_permission_content(params: &Value) -> Option<Value> {
    let mut texts = params
        .pointer("/toolCall/content")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(content_text);
    let input = parse_json_object(texts.next()?)?;
    texts.next().is_none().then_some(input)
}

fn content_text(value: &Value) -> Option<&str> {
    if value.get("type").and_then(Value::as_str) == Some("text") {
        return value.get("text").and_then(Value::as_str);
    }
    value.get("content").and_then(content_text)
}

fn parse_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    parse_object(trimmed).or_else(|| {
        let fenced = trimmed.strip_prefix("```")?.strip_suffix("```")?;
        let body = fenced
            .split_once('\n')
            .map_or(fenced, |(_, body)| body)
            .trim();
        parse_object(body)
    })
}

fn parse_object(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text)
        .ok()
        .filter(Value::is_object)
}

fn canonical_mcp_identity(tool_name: &str) -> Option<(&str, &str)> {
    let canonical = tool_name.strip_prefix("mcp__")?;
    let (server, tool) = canonical.split_once("__")?;
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}

fn strip_cursor_placeholder(mut input: Value) -> Value {
    if let Value::Object(ref mut object) = input {
        if object.get("description").and_then(Value::as_str) == Some("MCP: tool") {
            object.remove("description");
        }
    }
    input
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_tool_name, derive_permission_tool_input, mcp_input_from_permission_content,
        normalize_tool_input,
    };
    use serde_json::json;

    #[test]
    fn canonicalizes_cursor_tool_names() {
        assert_eq!(canonical_tool_name("shellToolCall"), "Bash");
        assert_eq!(canonical_tool_name("write_file"), "Write");
        assert_eq!(canonical_tool_name("grep"), "Search");
        assert_eq!(canonical_tool_name("search_files"), "Search");
        assert_eq!(canonical_tool_name("rename_file"), "Move");
        assert_eq!(canonical_tool_name("switch_mode"), "SwitchMode");
        assert_eq!(canonical_tool_name("apply_patch"), "ApplyPatch");
        assert_eq!(canonical_tool_name("Task: Subagent task"), "Agent");
        assert_eq!(canonical_tool_name("Create Plan"), "ExitPlanMode");
        assert_eq!(
            canonical_tool_name("mcp__tools__search"),
            "mcp__tools__search"
        );
        assert_eq!(canonical_tool_name("MCP: tool"), "mcp__mcp__tool");
        assert_eq!(
            canonical_tool_name("probe-server-echo_probe: echo_probe"),
            "mcp__probe-server__echo_probe"
        );
        assert_eq!(
            canonical_tool_name("cadencr-browser-browser_open_url: browser_open_url"),
            "mcp__cadencr-browser__browser_open_url"
        );
        assert_eq!(canonical_tool_name("run shell: shell"), "run shell: shell");
    }

    #[test]
    fn normalizes_cursor_write_and_edit_inputs() {
        assert_eq!(
            normalize_tool_input("Write", json!({ "path": "a.rs", "fileText": "x" })),
            json!({ "file_path": "a.rs", "content": "x" })
        );
        assert_eq!(
            normalize_tool_input(
                "Edit",
                json!({ "filePath": "a.rs", "oldText": "a", "newText": "b" })
            ),
            json!({ "file_path": "a.rs", "old_string": "a", "new_string": "b" })
        );
        assert_eq!(
            normalize_tool_input(
                "Write",
                json!({ "path": "a.rs", "newText": "y", "oldText": "z" })
            ),
            json!({ "file_path": "a.rs", "content": "y" })
        );
        assert_eq!(
            normalize_tool_input("Bash", json!({ "path": "keep" })),
            json!({ "path": "keep" })
        );
    }

    #[test]
    fn adds_explicit_identity_when_permission_reveals_cursor_mcp_tool() {
        assert_eq!(
            normalize_tool_input(
                "mcp__chrome-devtools__new_page",
                json!({ "description": "MCP: tool" })
            ),
            json!({ "server": "chrome-devtools", "tool": "new_page", "arguments": {} })
        );
        assert_eq!(
            normalize_tool_input("mcp__probe-server__echo_probe", json!({ "text": "hello" })),
            json!({
                "server": "probe-server",
                "tool": "echo_probe",
                "arguments": { "text": "hello" }
            })
        );
    }

    #[test]
    fn leaves_cursor_mcp_identity_envelopes_idempotent() {
        let input = json!({
            "server": "chrome-devtools",
            "tool": "new_page",
            "arguments": { "url": "https://google.com" }
        });
        assert_eq!(
            normalize_tool_input("mcp__chrome-devtools__new_page", input.clone()),
            input
        );
    }

    #[test]
    fn extracts_only_structured_cursor_mcp_permission_input() {
        let params = json!({
            "toolCall": {
                "content": [{
                    "type": "content",
                    "content": {
                        "type": "text",
                        "text": "```json\n{\n  \"text\": \"composer-2.5-cadencr\"\n}\n```"
                    }
                }]
            }
        });
        assert_eq!(
            mcp_input_from_permission_content(&params),
            Some(json!({ "text": "composer-2.5-cadencr" }))
        );
        assert_eq!(
            derive_permission_tool_input(
                "mcp__probe-server__echo_probe",
                json!({ "description": "MCP: tool" }),
                &params,
            ),
            json!({ "text": "composer-2.5-cadencr" })
        );
        assert_eq!(
            derive_permission_tool_input(
                "mcp__probe-server__echo_probe",
                json!({ "text": "authoritative raw input" }),
                &params,
            ),
            json!({ "text": "authoritative raw input" })
        );
        let safety = json!({
            "toolCall": {
                "content": [{ "type": "text", "text": "Approval required by a newer policy" }]
            }
        });
        assert_eq!(mcp_input_from_permission_content(&safety), None);
    }
}
