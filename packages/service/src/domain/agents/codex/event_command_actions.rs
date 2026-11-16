use serde_json::{json, Value};

use super::event_items::{item_failed, stream_start_event, tool_result_event_with_error};
use super::event_json::thread_id;
use super::event_state::IndexState;
use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEvent};

pub(super) fn command_action_events(
    params: &Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let Some(item) = params.get("item") else {
        return Vec::new();
    };
    if !is_exploring_command_item(item) {
        return Vec::new();
    }
    let Some(actions) = command_actions(item) else {
        return Vec::new();
    };
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("codex_item");
    let failure = completed.then(|| failure_output(item, actions)).flatten();
    actions
        .iter()
        .enumerate()
        .filter_map(|(index, action)| command_action_tool_use(action, item_id, index))
        .flat_map(|tool| command_action_tool_events(params, tool, failure.as_ref(), index_state))
        .collect()
}

/// What a failed exploring command reports: its output (`cat`'s "No such
/// file or directory"), else its exit status. A successful one still
/// reports no result.
fn failure_output(item: &Value, actions: &[Value]) -> Option<Value> {
    if !item_failed(item) {
        return None;
    }
    let output = item
        .get("aggregatedOutput")
        .and_then(Value::as_str)
        .map(str::trim_end)
        .filter(|output| !output.is_empty());
    let exit_code = item.get("exitCode").and_then(Value::as_i64);
    if output.is_none() && exit_code == Some(1) && only_searches(actions) {
        // `rg` and `grep` exit 1 when nothing matches: Codex reports that
        // search as failed, but it found nothing, which is no error.
        return None;
    }
    Some(json!(match (output, exit_code) {
        (Some(output), _) => output.to_string(),
        (None, Some(code)) => format!("Command exited with status {code}"),
        (None, None) => "Command failed".to_string(),
    }))
}

fn only_searches(actions: &[Value]) -> bool {
    actions.iter().all(|action| {
        matches!(
            command_action_tool_name(action).as_deref(),
            Some("Grep" | "Glob")
        )
    })
}

pub(super) fn has_exploring_command_actions(params: &Value) -> bool {
    params.get("item").is_some_and(is_exploring_command_item)
}

fn is_exploring_command_item(item: &Value) -> bool {
    !is_user_shell_command(item)
        && command_actions(item).is_some_and(|actions| {
            !actions.is_empty()
                && actions.iter().enumerate().all(|(index, action)| {
                    command_action_tool_use(action, "codex_item", index).is_some()
                })
        })
}

fn is_user_shell_command(item: &Value) -> bool {
    matches!(
        item.get("source").and_then(Value::as_str),
        Some("userShell")
    )
}

fn command_actions(item: &Value) -> Option<&Vec<Value>> {
    item.get("commandActions")
        .or_else(|| item.get("command_actions"))
        .and_then(Value::as_array)
}

struct CommandActionToolUse {
    id: String,
    name: String,
    input: Value,
}

/// A tool's start once, and, when its command failed, its error result: the
/// command's tools share its single output and exit status, so each one
/// carries the failure.
fn command_action_tool_events(
    params: &Value,
    tool: CommandActionToolUse,
    failure: Option<&Value>,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    let mut events = Vec::new();
    if !index_state.has_index(&tool.id) {
        let block = RuntimeContentBlock::ToolUse {
            id: tool.id.clone(),
            name: tool.name,
            input: tool.input,
        };
        events.push(stream_start_event(
            thread_id(params),
            index_state.index_for(&tool.id),
            block,
        ));
    }
    if let Some(output) = failure {
        if index_state.record_result(&tool.id) {
            events.push(tool_result_event_with_error(
                params,
                tool.id,
                output.clone(),
                true,
            ));
        }
    }
    events
}

fn command_action_tool_use(
    action: &Value,
    item_id: &str,
    index: usize,
) -> Option<CommandActionToolUse> {
    let name = command_action_tool_name(action)?;
    let input = command_action_input(&name, action)?;
    Some(CommandActionToolUse {
        id: format!("{item_id}:command_action:{index}"),
        name,
        input,
    })
}

fn command_action_tool_name(action: &Value) -> Option<String> {
    match action_kind(action)? {
        "read" => Some("Read".to_string()),
        "list" | "listFiles" | "ls" => Some("LS".to_string()),
        "glob" => Some("Glob".to_string()),
        "search" | "grep" => Some("Grep".to_string()),
        _ => None,
    }
}

fn command_action_input(tool_name: &str, action: &Value) -> Option<Value> {
    let mut input = full_action_input(action);
    match tool_name {
        "Read" => {
            input
                .entry("file_path".to_string())
                .or_insert(json!(action_target(action)?));
            Some(Value::Object(input))
        }
        "LS" => {
            input
                .entry("path".to_string())
                .or_insert(json!(action_target(action)?));
            Some(Value::Object(input))
        }
        "Glob" => {
            input
                .entry("path".to_string())
                .or_insert(json!(action_target(action)?));
            input
                .entry("pattern".to_string())
                .or_insert(json!(
                    action_string(action, &["pattern", "glob"]).unwrap_or("*")
                ));
            Some(Value::Object(input))
        }
        "Grep" => {
            input
                .entry("pattern".to_string())
                .or_insert(json!(action_string(action, &["pattern", "query", "regex"])
                    .or_else(|| action_target(action))?));
            if let Some(path) = action_string(action, &["path", "directory", "dir"]) {
                input.entry("path".to_string()).or_insert(json!(path));
            }
            Some(Value::Object(input))
        }
        _ => None,
    }
}

fn full_action_input(action: &Value) -> serde_json::Map<String, Value> {
    match action.as_object() {
        Some(object) => object.clone(),
        None => serde_json::Map::from_iter([("value".to_string(), action.clone())]),
    }
}

fn action_kind(action: &Value) -> Option<&str> {
    if let Some(value) = action.as_str() {
        return Some(value);
    }
    action_string(action, &["type", "action", "kind", "name"])
}

fn action_target(action: &Value) -> Option<&str> {
    action_string(
        action,
        &[
            "path",
            "file_path",
            "filePath",
            "directory",
            "dir",
            "query",
            "pattern",
        ],
    )
}

fn action_string<'a>(action: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let object = action.as_object()?;
    keys.iter().find_map(|key| object.get(*key)?.as_str())
}

#[cfg(test)]
mod tests {
    use super::{command_action_events, has_exploring_command_actions};
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeStreamEvent};
    use crate::domain::agents::codex::event_state::IndexState;
    use crate::domain::agents::codex::events::notification_events;
    use serde_json::{json, Value};

    fn tool_names(events: &[crate::domain::agents::adapter::RuntimeEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match event.stream_event()? {
                RuntimeStreamEvent::ContentBlockStart {
                    block: RuntimeContentBlock::ToolUse { name, .. },
                    ..
                } => Some(name.clone()),
                _ => None,
            })
            .collect()
    }

    fn first_tool_input(events: &[crate::domain::agents::adapter::RuntimeEvent]) -> Value {
        events
            .iter()
            .find_map(|event| match event.stream_event()? {
                RuntimeStreamEvent::ContentBlockStart {
                    block: RuntimeContentBlock::ToolUse { input, .. },
                    ..
                } => Some(input.clone()),
                _ => None,
            })
            .expect("expected tool input")
    }

    #[test]
    fn command_actions_emit_classic_tool_calls() {
        let params = json!({
            "threadId": "thread",
            "item": {
                "type": "commandExecution",
                "id": "cmd",
                "commandActions": [
                    { "type": "read", "path": "/etc/hosts" },
                    { "type": "list", "path": "packages/service" },
                    { "type": "search", "query": "RuntimeEvent", "path": "packages/service" }
                ]
            }
        });
        let mut indexes = IndexState::default();

        assert!(has_exploring_command_actions(&params));
        let events = command_action_events(&params, false, &mut indexes);

        assert_eq!(tool_names(&events), vec!["Read", "LS", "Grep"]);
        let input = first_tool_input(&events);
        assert_eq!(input["type"], "read");
        assert_eq!(input["path"], "/etc/hosts");
        assert_eq!(input["file_path"], "/etc/hosts");
    }

    #[test]
    fn non_exploring_command_actions_do_not_emit_virtual_tools() {
        let mut indexes = IndexState::default();
        let params = json!({
            "threadId": "thread",
            "item": {
                "type": "commandExecution",
                "id": "cmd",
                "source": "agent",
                "command": "cat package.json && pnpm test",
                "commandActions": [
                    { "type": "read", "path": "package.json" },
                    { "type": "unknown", "command": "pnpm test" }
                ]
            }
        });

        assert!(!has_exploring_command_actions(&params));
        assert!(command_action_events(&params, false, &mut indexes).is_empty());
        let events = notification_events("item/completed", params, None, &mut indexes);
        assert_eq!(tool_names(&events), vec!["Bash"]);
    }

    #[test]
    fn user_shell_command_actions_do_not_emit_virtual_tools() {
        let mut indexes = IndexState::default();
        let params = json!({
            "threadId": "thread",
            "item": {
                "type": "commandExecution",
                "id": "cmd",
                "source": "userShell",
                "commandActions": [{ "type": "read", "path": "/etc/hosts" }]
            }
        });

        assert!(!has_exploring_command_actions(&params));
        assert!(command_action_events(&params, false, &mut indexes).is_empty());
    }

    #[test]
    fn completed_command_actions_do_not_duplicate_started_actions() {
        let params = json!({
            "threadId": "thread",
            "item": {
                "type": "commandExecution",
                "id": "cmd",
                "commandActions": [{ "type": "read", "path": "README.md" }]
            }
        });
        let mut indexes = IndexState::default();

        assert_eq!(command_action_events(&params, false, &mut indexes).len(), 1);
        assert!(command_action_events(&params, true, &mut indexes).is_empty());
    }

    #[test]
    fn command_waits_for_completed_command_actions() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'"
                }
            }),
            None,
            &mut indexes,
        );
        let completed = notification_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'",
                    "commandActions": [{ "type": "read", "path": "/etc/hosts" }]
                }
            }),
            None,
            &mut indexes,
        );

        assert!(started.is_empty());
        assert_eq!(tool_names(&completed), vec!["Read"]);
    }

    #[test]
    fn unstreamed_command_without_actions_emits_bash_on_completion() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'"
                }
            }),
            None,
            &mut indexes,
        );
        let completed = notification_events(
            "item/completed",
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": "cmd",
                    "command": "/bin/zsh -lc 'cat /etc/hosts'",
                    "aggregatedOutput": "127.0.0.1 localhost",
                    "status": "completed"
                }
            }),
            None,
            &mut indexes,
        );

        assert!(started.is_empty());
        assert_eq!(tool_names(&completed), vec!["Bash"]);
        assert_eq!(completed.len(), 2);
    }

    /// The app-server's frames for `cat` on a missing file (codex-cli
    /// 0.167.0): the read completes `failed`, exit code 1, with cat's error
    /// as its output, and nothing else reports it.
    fn missing_file_read(status: &str, exit_code: Value, output: Value) -> Value {
        json!({
            "threadId": "thread",
            "turnId": "turn",
            "item": {
                "type": "commandExecution",
                "id": "exec-1",
                "command": "/bin/zsh -lc 'cat missing-file.txt'",
                "source": "unifiedExecStartup",
                "status": status,
                "commandActions": [{
                    "type": "read",
                    "command": "cat missing-file.txt",
                    "name": "missing-file.txt",
                    "path": "/repo/missing-file.txt"
                }],
                "aggregatedOutput": output,
                "exitCode": exit_code
            }
        })
    }

    fn tool_results(events: &[crate::domain::agents::adapter::RuntimeEvent]) -> Vec<(bool, Value)> {
        events
            .iter()
            .filter_map(|event| event.user_message())
            .flat_map(|message| &message.content)
            .filter_map(|block| match block {
                crate::domain::agents::adapter::RuntimeUserContentBlock::ToolResult {
                    is_error,
                    content,
                    ..
                } => Some((*is_error, content.clone())),
                _ => None,
            })
            .collect()
    }

    /// Found in QA: a read of a missing file showed as a plain read, with no
    /// failure in any view.
    #[test]
    fn a_failed_read_reports_its_output_as_an_error_result() {
        let mut indexes = IndexState::default();
        let started = notification_events(
            "item/started",
            missing_file_read("inProgress", Value::Null, Value::Null),
            None,
            &mut indexes,
        );
        let completed = notification_events(
            "item/completed",
            missing_file_read(
                "failed",
                json!(1),
                json!("cat: missing-file.txt: No such file or directory\n"),
            ),
            None,
            &mut indexes,
        );

        assert_eq!(tool_names(&started), vec!["Read"]);
        assert!(tool_results(&started).is_empty());
        assert!(tool_names(&completed).is_empty(), "started only once");
        assert_eq!(
            tool_results(&completed),
            vec![(
                true,
                json!("cat: missing-file.txt: No such file or directory")
            )]
        );
    }

    #[test]
    fn a_failed_read_without_output_reports_its_exit_status() {
        let mut indexes = IndexState::default();
        let completed = notification_events(
            "item/completed",
            missing_file_read("failed", json!(2), json!("")),
            None,
            &mut indexes,
        );

        assert_eq!(tool_names(&completed), vec!["Read"]);
        assert_eq!(
            tool_results(&completed),
            vec![(true, json!("Command exited with status 2"))]
        );
    }

    #[test]
    fn a_successful_read_still_reports_no_result() {
        let mut indexes = IndexState::default();
        let completed = notification_events(
            "item/completed",
            missing_file_read("completed", json!(0), json!("hello\n")),
            None,
            &mut indexes,
        );

        assert_eq!(tool_names(&completed), vec!["Read"]);
        assert!(tool_results(&completed).is_empty());
    }

    /// `rg zzqqxxnomatch .` as codex-cli 0.167.0 reports it: `failed`, exit 1,
    /// no output. Nothing matched; the search did not fail.
    #[test]
    fn a_search_that_matches_nothing_reports_no_error() {
        let mut indexes = IndexState::default();
        let search = |exit_code: i64, output: Value| {
            json!({
                "threadId": "thread",
                "item": {
                    "type": "commandExecution",
                    "id": format!("exec-{exit_code}"),
                    "command": "/bin/zsh -lc 'rg zzqqxxnomatch .'",
                    "status": "failed",
                    "commandActions": [{
                        "type": "search",
                        "command": "rg zzqqxxnomatch .",
                        "query": "zzqqxxnomatch",
                        "path": "."
                    }],
                    "aggregatedOutput": output,
                    "exitCode": exit_code
                }
            })
        };

        let nothing_found =
            notification_events("item/completed", search(1, Value::Null), None, &mut indexes);
        let broken = notification_events(
            "item/completed",
            search(2, json!("rg: regex parse error")),
            None,
            &mut indexes,
        );

        assert_eq!(tool_names(&nothing_found), vec!["Grep"]);
        assert!(tool_results(&nothing_found).is_empty());
        assert_eq!(
            tool_results(&broken),
            vec![(true, json!("rg: regex parse error"))]
        );
    }
}
