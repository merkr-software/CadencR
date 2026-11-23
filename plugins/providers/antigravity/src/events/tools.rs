use serde_json::{json, Map, Value};

use super::mcp;

pub(super) fn normalize_update(update: &mut Value, servers: &[String]) {
    if !matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("tool_call" | "tool_call_update")
    ) {
        return;
    }
    let Some(call) = update.as_object_mut() else {
        return;
    };
    normalize_call(call, servers);
    if text(call, "sessionUpdate") == Some("tool_call_update") {
        normalize_result(call);
    }
}

pub(super) fn normalize_permission(tool_call: &mut Value, servers: &[String]) {
    if let Some(call) = tool_call.as_object_mut() {
        normalize_call(call, servers);
    }
}

pub(super) fn call_name(call: &Map<String, Value>) -> Option<&str> {
    text(call, "toolName").or_else(|| text(call, "name"))
}

pub(super) fn is_subagent_launch(name: &str) -> bool {
    matches!(name, "invoke_subagent" | "start_subagent")
}

fn normalize_call(call: &mut Map<String, Value>, servers: &[String]) {
    let Some(native_name) = call_name(call) else {
        return;
    };
    let name = match native_name {
        "run_command" => "Bash",
        "read_file" | "view_file" | "client_view_file" => "Read",
        "create_file" | "write_file" | "write_to_file" => "Write",
        "edit_file" | "replace_file_content" => "Edit",
        "multi_replace_file_content" => "MultiEdit",
        "list_directory" | "list_dir" => "LS",
        "search_directory" | "grep_search" => "Grep",
        "find_file" | "find_by_name" => "Glob",
        "search_web" => "WebSearch",
        "read_url_content" => "WebFetch",
        name if is_subagent_launch(name) => "Agent",
        name if name.starts_with("mcp_") => {
            let name = name.to_owned();
            mcp::normalize_call(call, &name, servers);
            return;
        }
        _ => return,
    };
    set_name(call, name);
    normalize_input(call, name);
}

/// `toolName` takes precedence in CadencR when the optional alias is present.
pub(super) fn set_name(call: &mut Map<String, Value>, name: &str) {
    call.insert("name".to_owned(), json!(name));
    if call.contains_key("toolName") {
        call.insert("toolName".to_owned(), json!(name));
    }
}

fn normalize_input(call: &mut Map<String, Value>, name: &str) {
    let raw = match call.get("rawInput") {
        Some(Value::Object(_)) => call.remove("rawInput"),
        None | Some(Value::Null) => call.get("args").cloned(),
        _ => return,
    };
    let diff = call
        .get("content")
        .and_then(Value::as_array)
        .and_then(|content| content.iter().find(|block| block["type"] == "diff"))
        .and_then(Value::as_object);
    let Some(Value::Object(mut input)) = raw.or_else(|| diff.map(|_| json!({}))) else {
        return;
    };

    match name {
        "Bash" => {
            copy_text(
                &mut input,
                "command",
                &["CommandLine", "commandLine", "command_line"],
            );
            copy_text(
                &mut input,
                "cwd",
                &["Cwd", "WorkingDirectory", "working_dir"],
            );
            copy_text(&mut input, "description", &["toolSummary"]);
        }
        "Read" | "Edit" | "Write" | "MultiEdit" => {
            copy_text(
                &mut input,
                "file_path",
                &["Path", "AbsolutePath", "absolute_path", "TargetFile"],
            );
            fill_edit_input(&mut input, name, diff);
        }
        "LS" | "Grep" | "Glob" => {
            copy_text(
                &mut input,
                "path",
                &["Path", "DirectoryPath", "SearchPath", "SearchDirectory"],
            );
            copy_text(&mut input, "pattern", &["Pattern", "Query"]);
        }
        "WebFetch" => copy_text(&mut input, "url", &["Url"]),
        "Agent" => {
            copy_text(&mut input, "prompt", &["Prompt"]);
            copy_text(&mut input, "name", &["Role"]);
            copy_text(&mut input, "subagent_type", &["TypeName"]);
            copy_text(
                &mut input,
                "description",
                &["Description", "toolSummary", "Role"],
            );
        }
        _ => {}
    }
    call.insert("rawInput".to_owned(), Value::Object(input));
}

fn fill_edit_input(input: &mut Map<String, Value>, name: &str, diff: Option<&Map<String, Value>>) {
    match name {
        "Edit" => {
            copy_text(
                input,
                "old_string",
                &["Target", "TargetContent", "target_content"],
            );
            copy_text(
                input,
                "new_string",
                &["Replacement", "ReplacementContent", "replacement_content"],
            );
        }
        "Write" => copy_text(input, "content", &["Content", "CodeContent"]),
        _ => {}
    }
    let Some(diff) = diff else {
        return;
    };
    fill_text(input, "file_path", text(diff, "path"));
    if name == "Edit" {
        fill_text(input, "old_string", text(diff, "oldText"));
        fill_text(input, "new_string", text(diff, "newText"));
    } else if name == "Write" {
        fill_text(input, "content", text(diff, "newText"));
    }
}

fn normalize_result(call: &mut Map<String, Value>) {
    let is_bash = text(call, "name") == Some("Bash");
    if let Some(output) = call.get_mut("rawOutput").filter(|value| !value.is_null()) {
        if let (true, Some(output)) = (is_bash, output.as_object_mut()) {
            copy_text(
                output,
                "aggregatedOutput",
                &["combinedOutput", "combined_output"],
            );
            if let Some(code) = output.get("exit_code").and_then(Value::as_i64) {
                output.entry("exitCode").or_insert_with(|| json!(code));
            }
        }
        return;
    }
    let content = call
        .get("content")
        .and_then(Value::as_array)
        .filter(|content| !content.is_empty());
    let texts =
        content.and_then(|blocks| blocks.iter().map(content_text).collect::<Option<Vec<_>>>());
    let output = match texts {
        Some(texts) => Value::String(texts.join("\n")),
        // The host derives a failed tool card from a result. Some denied edits
        // have a terminal failed status as their only failure payload.
        None if content.is_none() && text(call, "status") == Some("failed") => {
            json!({"status":"failed"})
        }
        None => return,
    };
    call.insert("rawOutput".to_owned(), output);
}

fn content_text(block: &Value) -> Option<&str> {
    let content = match block.get("type")?.as_str()? {
        "content" => block.get("content")?,
        "text" => block,
        _ => return None,
    };
    if content.get("type")?.as_str()? != "text" {
        return None;
    }
    content.get("text")?.as_str()
}

fn text<'a>(fields: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    fields.get(key).and_then(Value::as_str)
}

fn copy_text(fields: &mut Map<String, Value>, key: &str, sources: &[&str]) {
    if !fields.contains_key(key) {
        if let Some(value) = sources.iter().find_map(|source| text(fields, source)) {
            fields.insert(key.to_owned(), json!(value));
        }
    }
}

fn fill_text(fields: &mut Map<String, Value>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        fields.entry(key).or_insert_with(|| json!(value));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_write_file_keeps_write_options_and_exposes_content() {
        for flags in [json!({"Overwrite":true}), json!({"Append":true})] {
            let mut args = flags.clone();
            args["Path"] = json!("example.md");
            args["Content"] = json!("More text");
            let mut call =
                json!({"sessionUpdate":"tool_call","toolName":"write_file","rawInput":args});
            normalize_update(&mut call, &[]);
            assert_eq!(call["toolName"], "Write");
            assert_eq!(call["rawInput"]["file_path"], "example.md");
            assert_eq!(call["rawInput"]["content"], "More text");
            for (key, value) in flags.as_object().unwrap() {
                assert_eq!(&call["rawInput"][key], value);
            }
        }
    }

    #[test]
    fn normalizes_live_command_input_and_completion_without_losing_details() {
        let mut call = json!({
            "sessionUpdate":"tool_call_update","name":"run_command","toolCallId":"c","kind":"execute","status":"completed",
            "rawInput":{"CommandLine":"printf fixture","WaitMsBeforeAsync":5000,"toolSummary":"Print fixture string"},
            "rawOutput":{"output":"fixture","exit_code":0},
            "content":[{"type":"content","content":{"type":"text","text":"fixture"}}]
        });
        normalize_update(&mut call, &[]);
        assert_eq!(call["toolCallId"], "c");
        assert_eq!(call["name"], "Bash");
        assert_eq!(call["rawInput"]["command"], "printf fixture");
        assert_eq!(call["rawInput"]["description"], "Print fixture string");
        assert_eq!(call["rawInput"]["WaitMsBeforeAsync"], 5000);
        assert_eq!(
            call["rawOutput"],
            json!({"output":"fixture","exit_code":0,"exitCode":0})
        );
        assert_eq!(call["content"][0]["content"]["text"], "fixture");
    }

    #[test]
    fn edit_permission_preserves_diff_and_a_bare_failure_remains_visible() {
        let mut call = json!({
            "name":"edit_file","toolCallId":"c","kind":"edit","status":"pending",
            "rawInput":{"Path":"/fixture.txt","Target":"before","Replacement":"after"},
            "content":[{"type":"diff","path":"/fixture.txt","oldText":"before","newText":"after"}]
        });
        normalize_permission(&mut call, &[]);
        assert_eq!(call["name"], "Edit");
        assert_eq!(call["rawInput"]["file_path"], "/fixture.txt");
        assert_eq!(call["rawInput"]["old_string"], "before");
        assert_eq!(call["rawInput"]["new_string"], "after");
        assert_eq!(call["content"][0]["type"], "diff");

        let mut failed = json!({"sessionUpdate":"tool_call_update","toolCallId":"c","name":"edit_file","status":"failed"});
        normalize_update(&mut failed, &[]);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["rawOutput"], json!({"status":"failed"}));
    }

    #[test]
    fn reads_keep_the_native_path_and_report_no_unsent_result() {
        let mut call = json!({
            "sessionUpdate":"tool_call_update","name":"read_file","toolCallId":"r","status":"completed",
            "locations":[{"path":"/fixture.txt"}],"rawInput":{"Path":"/fixture.txt"}
        });
        normalize_update(&mut call, &[]);
        assert_eq!(call["name"], "Read");
        assert_eq!(call["rawInput"]["file_path"], "/fixture.txt");
        assert_eq!(call["locations"][0]["path"], "/fixture.txt");
        assert!(call.get("rawOutput").is_none());
    }

    #[test]
    fn native_subagent_call_projects_launch_metadata_without_a_child_session() {
        let mut call = json!({
            "sessionUpdate":"tool_call_update","name":"invoke_subagent","toolCallId":"child-call","status":"completed",
            "rawInput":{"Prompt":"Reply with the fixture marker.","Role":"Fixture Responder","TypeName":"research"}
        });
        normalize_update(&mut call, &[]);
        assert_eq!(call["name"], "Agent");
        assert_eq!(call["status"], "completed");
        assert_eq!(call["toolCallId"], "child-call");
        assert_eq!(call["rawInput"]["prompt"], "Reply with the fixture marker.");
        assert_eq!(call["rawInput"]["name"], "Fixture Responder");
        assert_eq!(call["rawInput"]["subagent_type"], "research");
        assert!(call.get("rawOutput").is_none());
        assert!(call.get("sessionId").is_none());
    }

    #[test]
    fn projects_wrapped_text_and_preserves_structured_results() {
        let mut call = json!({
            "sessionUpdate":"tool_call_update","name":"unknown_tool","toolCallId":"u","status":"in_progress",
            "content":[{"type":"content","content":{"type":"text","text":"step 1"}},{"type":"text","text":"step 2"}]
        });
        normalize_update(&mut call, &[]);
        assert_eq!(call["name"], "unknown_tool");
        assert_eq!(call["rawOutput"], "step 1\nstep 2");
        let patch = json!({
            "sessionUpdate":"tool_call_update","name":"unknown_tool","toolCallId":"u","status":"completed",
            "content":[{"type":"diff","path":"file","newText":"one"},{"type":"unknown","future":true}]
        });
        let mut call = patch.clone();
        normalize_update(&mut call, &[]);
        assert_eq!(call, patch);
    }
}
