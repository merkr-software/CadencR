use std::collections::HashMap;

use serde_json::{json, Value};

use super::super::models::AgentMessageRow;

#[derive(Debug, Clone)]
struct TaskTodo {
    id: String,
    content: String,
    status: String,
    active_form: String,
}

pub(super) fn latest_todos_from_messages(messages: &[AgentMessageRow]) -> Option<Vec<Value>> {
    messages.iter().rev().find_map(|message| {
        match (message.message_type.as_str(), message.tool_name.as_deref()) {
            ("tool_call", Some("TodoWrite")) => latest_todo_write(message),
            ("tool_call", Some("TaskCreate" | "TaskUpdate")) => task_todos_from_messages(messages),
            _ => None,
        }
    })
}

fn latest_todo_write(message: &AgentMessageRow) -> Option<Vec<Value>> {
    let parsed = serde_json::from_str::<Value>(&message.content).ok()?;
    parsed.get("todos")?.as_array().cloned()
}

fn task_todos_from_messages(messages: &[AgentMessageRow]) -> Option<Vec<Value>> {
    let mut tasks = Vec::<TaskTodo>::new();
    let mut index_by_id = HashMap::<String, usize>::new();
    let mut create_tool_to_task = HashMap::<String, String>::new();
    let mut saw_task_tool = false;

    for message in messages {
        match (message.message_type.as_str(), message.tool_name.as_deref()) {
            ("tool_call", Some("TaskCreate")) => {
                saw_task_tool = true;
                handle_task_create(
                    message,
                    &mut tasks,
                    &mut index_by_id,
                    &mut create_tool_to_task,
                );
            }
            ("tool_call", Some("TaskUpdate")) => {
                saw_task_tool = true;
                handle_task_update(message, &mut tasks, &mut index_by_id);
            }
            ("tool_result", _) | ("tool_error", _) => {
                handle_task_create_result(
                    message,
                    &mut tasks,
                    &mut index_by_id,
                    &mut create_tool_to_task,
                );
            }
            _ => {}
        }
    }

    if !saw_task_tool {
        return None;
    }
    Some(
        tasks
            .into_iter()
            .map(|task| {
                json!({
                    "content": task.content,
                    "status": task.status,
                    "activeForm": task.active_form,
                })
            })
            .collect(),
    )
}

fn handle_task_create(
    message: &AgentMessageRow,
    tasks: &mut Vec<TaskTodo>,
    index_by_id: &mut HashMap<String, usize>,
    create_tool_to_task: &mut HashMap<String, String>,
) {
    let Some(input) = parse_object(&message.content) else {
        return;
    };
    let fallback_id = message
        .tool_use_id
        .clone()
        .unwrap_or_else(|| format!("task-create-{}", message.id));
    let id = string_field(&input, "id")
        .or_else(|| string_field(&input, "taskId"))
        .unwrap_or(fallback_id);
    let task = TaskTodo {
        id: id.clone(),
        content: string_field(&input, "subject")
            .or_else(|| string_field(&input, "content"))
            .unwrap_or_default(),
        status: todo_status(input.get("status")).unwrap_or_else(|| "pending".to_string()),
        active_form: string_field(&input, "activeForm").unwrap_or_default(),
    };
    upsert_task(task, tasks, index_by_id);
    if let Some(tool_use_id) = &message.tool_use_id {
        create_tool_to_task.insert(tool_use_id.clone(), id);
    }
}

fn handle_task_create_result(
    message: &AgentMessageRow,
    tasks: &mut [TaskTodo],
    index_by_id: &mut HashMap<String, usize>,
    create_tool_to_task: &mut HashMap<String, String>,
) {
    let Some(tool_use_id) = &message.tool_use_id else {
        return;
    };
    let Some(provisional_id) = create_tool_to_task.get(tool_use_id).cloned() else {
        return;
    };
    let Some(authoritative_id) = task_id_from_result_content(&message.content) else {
        return;
    };
    if authoritative_id == provisional_id {
        return;
    }
    let Some(index) = index_by_id.remove(&provisional_id) else {
        return;
    };
    tasks[index].id = authoritative_id.clone();
    index_by_id.insert(authoritative_id.clone(), index);
    create_tool_to_task.insert(tool_use_id.clone(), authoritative_id);
}

fn handle_task_update(
    message: &AgentMessageRow,
    tasks: &mut Vec<TaskTodo>,
    index_by_id: &mut HashMap<String, usize>,
) {
    let Some(input) = parse_object(&message.content) else {
        return;
    };
    let Some(task_id) = string_field(&input, "taskId").or_else(|| string_field(&input, "id"))
    else {
        return;
    };
    if input.get("status").and_then(Value::as_str) == Some("deleted") {
        remove_task(&task_id, tasks, index_by_id);
        return;
    }
    let Some(&index) = index_by_id.get(&task_id) else {
        return;
    };
    if let Some(content) =
        string_field(&input, "subject").or_else(|| string_field(&input, "content"))
    {
        tasks[index].content = content;
    }
    if let Some(active_form) = string_field(&input, "activeForm") {
        tasks[index].active_form = active_form;
    }
    if let Some(status) = todo_status(input.get("status")) {
        tasks[index].status = status;
    }
}

fn upsert_task(
    task: TaskTodo,
    tasks: &mut Vec<TaskTodo>,
    index_by_id: &mut HashMap<String, usize>,
) {
    if let Some(index) = index_by_id.get(&task.id).copied() {
        tasks[index] = task;
        return;
    }
    index_by_id.insert(task.id.clone(), tasks.len());
    tasks.push(task);
}

fn remove_task(id: &str, tasks: &mut Vec<TaskTodo>, index_by_id: &mut HashMap<String, usize>) {
    let Some(index) = index_by_id.remove(id) else {
        return;
    };
    tasks.remove(index);
    for (idx, task) in tasks.iter().enumerate().skip(index) {
        index_by_id.insert(task.id.clone(), idx);
    }
}

fn parse_object(content: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(content).ok()? {
        Value::Object(input) => Some(input),
        _ => None,
    }
}

fn string_field(input: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    input.get(key)?.as_str().map(ToOwned::to_owned)
}

fn task_id_from_object(input: &serde_json::Map<String, Value>) -> Option<String> {
    string_field(input, "id")
        .or_else(|| string_field(input, "taskId"))
        .or_else(|| input.get("task")?.as_object().and_then(task_id_from_object))
}

fn task_id_from_result_content(content: &str) -> Option<String> {
    match serde_json::from_str::<Value>(content).ok() {
        Some(Value::Object(result)) => task_id_from_object(&result),
        Some(Value::String(text)) => task_id_from_text_result(&text),
        _ => task_id_from_text_result(content),
    }
}

fn task_id_from_text_result(text: &str) -> Option<String> {
    let id_start = text.find("Task #")? + "Task #".len();
    let rest = text.get(id_start..)?;
    let id_end = rest.find(" created successfully")?;
    let id = rest.get(..id_end)?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn todo_status(value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(status @ ("pending" | "in_progress" | "completed")) => Some(status.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::super::models::AgentMessageRow;

    fn msg(
        id: i64,
        message_type: &str,
        tool_name: Option<&str>,
        tool_use_id: &str,
        content: serde_json::Value,
    ) -> AgentMessageRow {
        AgentMessageRow {
            id,
            session_id: 1,
            message_type: message_type.to_string(),
            content: content.to_string(),
            tool_name: tool_name.map(ToOwned::to_owned),
            tool_use_id: Some(tool_use_id.to_string()),
            parent_tool_use_id: None,
            created_at: None,
            model: None,
        }
    }

    fn call(
        id: i64,
        tool_name: &str,
        tool_use_id: &str,
        content: serde_json::Value,
    ) -> AgentMessageRow {
        msg(id, "tool_call", Some(tool_name), tool_use_id, content)
    }

    fn result(id: i64, tool_use_id: &str, content: serde_json::Value) -> AgentMessageRow {
        msg(id, "tool_result", None, tool_use_id, content)
    }

    fn expected(content: &str, status: &str, active_form: &str) -> serde_json::Value {
        json!({ "content": content, "status": status, "activeForm": active_form })
    }

    fn todo_write(id: i64, todos: serde_json::Value) -> AgentMessageRow {
        call(id, "TodoWrite", "todo-write-1", json!({ "todos": todos }))
    }

    #[test]
    fn reconstructs_task_todos_from_create_results_and_updates() {
        let messages = vec![
            call(
                1,
                "TaskCreate",
                "create-1",
                json!({"subject":"Write replay tests","activeForm":"Writing replay tests"}),
            ),
            result(2, "create-1", json!({"id":"task-1"})),
            call(
                3,
                "TaskUpdate",
                "update-1",
                json!({"taskId":"task-1","status":"in_progress","activeForm":"Implementing replay"}),
            ),
        ];

        assert_eq!(
            super::latest_todos_from_messages(&messages),
            Some(vec![expected(
                "Write replay tests",
                "in_progress",
                "Implementing replay",
            )])
        );
    }

    #[test]
    fn removes_deleted_task_todos() {
        let messages = vec![
            call(1, "TaskCreate", "create-1", json!({"subject":"Remove me"})),
            result(2, "create-1", json!({"id":"task-1"})),
            call(
                3,
                "TaskUpdate",
                "update-1",
                json!({"taskId":"task-1","status":"deleted"}),
            ),
        ];

        assert_eq!(super::latest_todos_from_messages(&messages), Some(vec![]));
    }

    #[test]
    fn task_create_result_after_todo_write_does_not_override_latest_snapshot() {
        let messages = vec![
            call(1, "TaskCreate", "create-1", json!({"subject":"Older task"})),
            todo_write(
                2,
                json!([{
                    "content": "Latest TodoWrite task",
                    "status": "completed",
                    "activeForm": "Finishing latest task"
                }]),
            ),
            result(3, "create-1", json!({"id":"task-1"})),
        ];

        assert_eq!(
            super::latest_todos_from_messages(&messages),
            Some(vec![expected(
                "Latest TodoWrite task",
                "completed",
                "Finishing latest task",
            )])
        );
    }

    #[test]
    fn task_create_result_ids_allow_updates_to_match_created_task() {
        for (create_result, task_id) in [
            (
                json!({"task":{"id":"task-1","subject":"Initial task"}}),
                "task-1",
            ),
            (json!("Task #1 created successfully: Initial task"), "1"),
        ] {
            let messages = vec![
                call(
                    1,
                    "TaskCreate",
                    "create-1",
                    json!({"subject":"Initial task","activeForm":"Doing initial task"}),
                ),
                result(2, "create-1", create_result),
                call(
                    3,
                    "TaskUpdate",
                    "update-1",
                    json!({
                        "taskId": task_id,
                        "subject":"Renamed task",
                        "status":"completed",
                        "activeForm":"Finishing renamed task"
                    }),
                ),
            ];

            assert_eq!(
                super::latest_todos_from_messages(&messages),
                Some(vec![expected(
                    "Renamed task",
                    "completed",
                    "Finishing renamed task",
                )])
            );
        }
    }
}
