use serde_json::{json, Value};

use crate::domain::agents::adapter::{RuntimeEvent, RuntimeEventMetadata};

use super::super::subagent::{subagent_type, task_notification_update};
use super::assistant_tool_event;

pub(super) fn events(
    method: &str,
    params: &Value,
    metadata: RuntimeEventMetadata,
) -> Option<Vec<RuntimeEvent>> {
    match method {
        "cursor/update_todos" => Some(vec![assistant_tool_event(
            params,
            "TodoWrite",
            json!({ "todos": normalized_todos(params) }),
            metadata,
        )]),
        "cursor/task" => Some(vec![assistant_tool_event(
            params,
            "Agent",
            task_input(params),
            metadata,
        )
        .with_subagent_updates(task_notification_update(params).into_iter().collect())]),
        "cursor/generate_image" => Some(vec![assistant_tool_event(
            params,
            "GenerateImage",
            params.clone(),
            metadata,
        )]),
        _ => None,
    }
}

pub(super) fn normalized_todos(params: &Value) -> Vec<Value> {
    params
        .get("todos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|todo| {
            let content = todo.get("content").and_then(Value::as_str).unwrap_or("");
            let raw_status = todo
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            // Keep cancelled distinct from completed so the UI progress count
            // does not treat abandoned todos as done.
            let status = if raw_status == "cancelled" {
                "pending"
            } else {
                raw_status
            };
            json!({
                "content": content,
                "status": status,
                "activeForm": content,
                "cursorTodoId": todo.get("id"),
                "cursorStatus": raw_status,
            })
        })
        .collect()
}

fn task_input(params: &Value) -> Value {
    json!({
        "description": params.get("description"),
        "prompt": params.get("prompt"),
        "subagentType": subagent_type(params.get("subagentType")),
        "model": params.get("model"),
        "agentId": params.get("agentId"),
        "durationMs": params.get("durationMs"),
    })
}

#[cfg(test)]
mod tests {
    use super::events;
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEventMetadata};
    use serde_json::json;

    #[test]
    fn todo_and_task_notifications_become_canonical_tools() {
        let todos = events(
            "cursor/update_todos",
            &json!({
                "toolCallId": "todo-1",
                "todos": [{ "id": "1", "content": "Ship", "status": "in_progress" }]
            }),
            RuntimeEventMetadata::default(),
        )
        .expect("known extension");
        assert!(matches!(
            &todos[0].assistant_message().unwrap().content[0],
            RuntimeContentBlock::ToolUse { name, .. } if name == "TodoWrite"
        ));

        let tasks = events(
            "cursor/task",
            &json!({ "toolCallId": "task-1", "description": "Explore", "model": "composer-2.5" }),
            RuntimeEventMetadata {
                raw: json!({ "type": "acp_extension", "method": "cursor/task" }),
                ..RuntimeEventMetadata::default()
            },
        )
        .expect("known extension");
        assert!(matches!(
            &tasks[0].assistant_message().unwrap().content[0],
            RuntimeContentBlock::ToolUse { name, .. } if name == "Agent"
        ));
        let raw = tasks[0].raw_json();
        assert_eq!(raw["type"], "assistant");
        assert_eq!(raw["message"]["content"][0]["id"], "task-1");
        assert_eq!(raw["message"]["content"][0]["name"], "Agent");
        assert_eq!(
            raw["message"]["content"][0]["input"]["description"],
            "Explore"
        );
        assert_eq!(raw["acp"]["type"], "acp_extension");
        let update = &tasks[0].subagent_updates()[0];
        assert_eq!(update.tool_use_id, "task-1");
        assert_eq!(update.patch.model.as_deref(), Some("composer-2.5"));
        assert!(update.patch.model_resolved);
    }

    #[test]
    fn task_notification_normalizes_custom_subagent_types() {
        // cursor-agent 2026.10.22 sends `{custom: name}` for user-defined agents.
        let tasks = events(
            "cursor/task",
            &json!({ "toolCallId": "task-2", "subagentType": { "custom": "reviewer" } }),
            RuntimeEventMetadata::default(),
        )
        .expect("known extension");
        let RuntimeContentBlock::ToolUse { input, .. } =
            &tasks[0].assistant_message().unwrap().content[0]
        else {
            panic!("expected tool use");
        };
        assert_eq!(input["subagentType"], "reviewer");
        // No real tool call id: the synthetic "Agent" id gets no sub-agent fact.
        let anonymous = events(
            "cursor/task",
            &json!({ "description": "Explore" }),
            RuntimeEventMetadata::default(),
        )
        .expect("known extension");
        assert!(anonymous[0].subagent_updates().is_empty());
    }
}
