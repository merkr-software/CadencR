//! Cursor todos → Cadencr's TodoWrite shape and standard ACP `plan` updates.
//!
//! Cursor's native `updateTodos` tool sends only the todos it changed, merged
//! by `id`, with protobuf-style statuses (`TODO_STATUS_COMPLETED`). The
//! connector keeps each session's full list so every update the host sees is
//! the whole list in canonical statuses.

use serde_json::{json, Map, Value};

/// One session's todo list as Cursor last described it, in first-seen order.
#[derive(Debug, Default)]
pub struct TodoBoard(Vec<Value>);

impl TodoBoard {
    /// Merge Cursor's `todos` by `id` (todos without one are appended) and
    /// return `params` with `todos` replaced by the full list.
    pub fn merge(&mut self, params: &Value) -> Value {
        let mut merged = params.clone();
        let Some(todos) = params.get("todos").and_then(Value::as_array) else {
            return merged;
        };
        for todo in todos {
            let id = todo.get("id").and_then(Value::as_str);
            let known = id.and_then(|id| {
                self.0
                    .iter_mut()
                    .find(|kept| kept.get("id").and_then(Value::as_str) == Some(id))
            });
            match known {
                Some(kept) => *kept = todo.clone(),
                None => self.0.push(todo.clone()),
            }
        }
        merged["todos"] = Value::Array(self.0.clone());
        merged
    }

    /// Rewrite a native `TodoWrite` tool call's input to the full list in
    /// Cadencr's TodoWrite shape.
    pub fn rewrite_tool_input(&mut self, update: &mut Map<String, Value>) {
        for key in ["rawInput", "toolInput"] {
            let Some(input) = update.get_mut(key) else {
                continue;
            };
            if input.get("todos").is_some_and(Value::is_array) {
                let merged = self.merge(input);
                input["todos"] = Value::Array(normalized_todos(&merged));
            }
        }
    }
}

/// Cadencr's TodoWrite-shaped todos (`content`, `status`, `activeForm`),
/// carried by `cursor/create_plan` input.
pub fn normalized_todos(params: &Value) -> Vec<Value> {
    todo_items(params)
        .map(|(todo, content, raw_status)| {
            json!({
                "content": content,
                "status": canonical_status(raw_status),
                "activeForm": content,
                "cursorTodoId": todo.get("id"),
                "cursorStatus": raw_status,
            })
        })
        .collect()
}

/// The `plan` update (`entries: [{content, priority, status}]`). Cursor's ids
/// and raw statuses ride along in each entry's `_meta`.
pub fn plan_update(params: &Value) -> Value {
    let entries: Vec<Value> = todo_items(params)
        .map(|(todo, content, raw_status)| {
            json!({
                "content": content,
                "priority": "medium",
                "status": canonical_status(raw_status),
                "_meta": { "cursorTodoId": todo.get("id"), "cursorStatus": raw_status },
            })
        })
        .collect();
    json!({ "sessionUpdate": "plan", "entries": entries })
}

fn todo_items(params: &Value) -> impl Iterator<Item = (&Value, &str, &str)> {
    params
        .get("todos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|todo| {
            let content = todo.get("content").and_then(Value::as_str).unwrap_or("");
            let status = todo
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            (todo, content, status)
        })
}

/// Keep cancelled distinct from completed so progress counts do not treat
/// abandoned todos as done; unknown statuses read as pending. Accepts both
/// `completed` and the native tool's `TODO_STATUS_COMPLETED`.
fn canonical_status(raw: &str) -> &'static str {
    let status = raw.strip_prefix("TODO_STATUS_").unwrap_or(raw);
    if status.eq_ignore_ascii_case("in_progress") {
        "in_progress"
    } else if status.eq_ignore_ascii_case("completed") {
        "completed"
    } else {
        "pending"
    }
}

#[cfg(test)]
mod tests {
    use super::{normalized_todos, plan_update, TodoBoard};
    use serde_json::{json, Value};

    #[test]
    fn native_tool_updates_merge_into_the_full_list_with_canonical_statuses() {
        let mut board = TodoBoard::default();
        let first = json!({
            "rawInput": { "_toolName": "updateTodos", "todos": [
                { "id": "a", "content": "Create", "status": "TODO_STATUS_IN_PROGRESS" },
                { "id": "b", "content": "Verify", "status": "TODO_STATUS_PENDING" }
            ] }
        });
        let mut update = first.as_object().unwrap().clone();
        board.rewrite_tool_input(&mut update);
        assert_eq!(update["rawInput"]["todos"][0]["status"], "in_progress");
        assert_eq!(update["rawInput"]["_toolName"], "updateTodos");

        // Cursor sends only the todo it changed.
        let later = json!({
            "rawInput": { "todos": [
                { "id": "a", "content": "Create", "status": "TODO_STATUS_COMPLETED" }
            ] }
        });
        let mut update = later.as_object().unwrap().clone();
        board.rewrite_tool_input(&mut update);
        let todos = update["rawInput"]["todos"].as_array().unwrap();
        let statuses: Vec<&Value> = todos.iter().map(|todo| &todo["status"]).collect();
        assert_eq!(statuses, [&json!("completed"), &json!("pending")]);
        assert_eq!(todos[0]["cursorStatus"], "TODO_STATUS_COMPLETED");
        assert_eq!(todos[1]["content"], "Verify");
    }

    #[test]
    fn plan_updates_carry_the_merged_list() {
        let mut board = TodoBoard::default();
        board.merge(&json!({ "todos": [
            { "id": "1", "content": "One", "status": "completed" },
            { "id": "2", "content": "Two", "status": "in_progress" }
        ] }));
        let update = plan_update(&board.merge(&json!({ "todos": [
            { "id": "2", "content": "Two", "status": "completed" }
        ] })));
        let entries = update["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1]["status"], "completed");
    }

    #[test]
    fn todos_become_a_standard_plan_update() {
        let params = json!({
            "toolCallId": "todo-1",
            "todos": [
                { "id": "1", "content": "Ship", "status": "in_progress" },
                { "id": "2", "content": "Drop", "status": "cancelled" },
                { "id": "3", "content": "Done", "status": "completed" }
            ]
        });
        let update = plan_update(&params);
        assert_eq!(update["sessionUpdate"], "plan");
        assert_eq!(update["entries"][0]["status"], "in_progress");
        assert_eq!(update["entries"][1]["status"], "pending");
        assert_eq!(update["entries"][1]["_meta"]["cursorStatus"], "cancelled");
        assert_eq!(update["entries"][2]["priority"], "medium");
        let todos = normalized_todos(&params);
        assert_eq!(todos[0]["activeForm"], "Ship");
        assert_eq!(todos[1]["cursorTodoId"], "2");
        assert!(plan_update(&json!({}))["entries"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
