use rmcp::model::Tool;
use serde_json::{json, Value};

use crate::domain::agents::providers::valid_provider_ids;
use crate::domain::mcp::settings_tool::SettingsTool;

#[path = "project_schema_descriptions.rs"]
mod descriptions;

use descriptions::{property_description, tool_description};
const PROJECT_TOOL_NAMES: [&str; 20] = [
    "project_list_sessions",
    "project_read_session",
    "project_read_session_tail",
    "project_get_session_status",
    "project_get_worktree_status",
    "project_find_related_sessions",
    "project_compare_sessions",
    "project_link_sessions",
    "project_list_agent_providers",
    "project_spawn_session",
    "project_send_session_message",
    "project_list_pending_gates",
    "project_respond_gate",
    "project_create_schedule",
    "project_list_schedules",
    "project_update_schedule",
    "project_delete_schedule",
    "project_archive_session",
    "project_get_settings",
    "project_update_settings",
];
pub(super) fn tools() -> Vec<Tool> {
    PROJECT_TOOL_NAMES
        .into_iter()
        .map(|name| make_tool(name, tool_description(name), tool_schema(name)))
        .collect()
}

fn make_tool(name: &'static str, description: &'static str, schema: Value) -> Tool {
    let obj: serde_json::Map<String, Value> =
        serde_json::from_value(schema).expect("schema must be an object");
    Tool::new(name, description, obj)
}

fn tool_schema(name: &str) -> Value {
    let schema = match name {
        "project_list_sessions" => json!({
            "type": "object",
            "properties": {
                "limit": { "type": "number" },
                "cursor": {
                    "type": "object",
                    "properties": {
                        "before_session_id": { "type": "number", "description": "Session id from the previous page's next_cursor." },
                        "before_started_at": { "type": "string", "description": "started_at value from the previous page's next_cursor." }
                    }
                }
            }
        }),
        "project_read_session" => paginated_session_schema(true),
        "project_read_session_tail" => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "number" },
                "after_message_id": { "type": "number" },
                "limit": { "type": "number" },
                "include_tool_details": { "type": "boolean" },
                "include_metadata": { "type": "boolean" }
            },
            "required": ["session_id"]
        }),
        "project_get_session_status" => json!({
            "type": "object",
            "properties": { "session_id": { "type": "number" } },
            "required": ["session_id"]
        }),
        "project_get_worktree_status" => json!({
            "type": "object",
            "properties": { "session_id": { "type": "number" } }
        }),
        "project_find_related_sessions" => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "number" },
                "snippet_chars": { "type": "number" }
            },
            "required": ["query"]
        }),
        "project_compare_sessions" => json!({
            "type": "object",
            "properties": {
                "left_session_id": { "type": "number" },
                "right_session_id": { "type": "number" }
            },
            "required": ["left_session_id", "right_session_id"]
        }),
        "project_link_sessions" => json!({
            "type": "object",
            "properties": {
                "target_session_id": { "type": "number" },
                "link_type": {
                    "type": "string",
                    "enum": ["spawned", "messaged", "referenced", "handoff"]
                },
                "note": { "type": "string" }
            },
            "required": ["target_session_id"]
        }),
        "project_list_agent_providers" => json!({ "type": "object", "properties": {} }),
        "project_spawn_session" => spawn_session_schema(),
        "project_send_session_message" => super::send_message_schema::schema(
            "Current-project session id receiving the follow-up message.",
        ),
        "project_list_pending_gates" | "project_respond_gate" => {
            super::project_gate_schema::schema(name)
        }
        "project_create_schedule" | "project_update_schedule" | "project_delete_schedule" => {
            super::project_schedule_schema::schema(name)
        }
        "project_archive_session" => super::project_archive_schema::schema(),
        "project_get_settings" => super::settings_schema::get_schema(SettingsTool::Project),
        "project_update_settings" => super::settings_schema::update_schema(SettingsTool::Project),
        _ => json!({ "type": "object", "properties": {} }),
    };
    document_schema(name, schema)
}

fn paginated_session_schema(include_query: bool) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": {
            "session_id": { "type": "number" },
            "roles": { "type": "array", "items": { "type": "string" } },
            "message_types": { "type": "array", "items": { "type": "string" } },
            "after_message_id": { "type": "number" },
            "before_message_id": { "type": "number" },
            "limit": { "type": "number" },
            "include_tool_details": { "type": "boolean" },
            "include_metadata": { "type": "boolean" }
        },
        "required": ["session_id"]
    });
    if include_query {
        schema["properties"]["query"] = json!({ "type": "string" });
    }
    schema
}

fn spawn_session_schema() -> Value {
    json!({
        "type": "object",
        "description": tool_description("project_spawn_session"),
        "properties": {
            "title": { "type": "string" }, "initial_message": { "type": "string" },
            "project_id": { "type": "number" }, "project_path": { "type": "string" },
            "provider": { "type": "string", "enum": valid_provider_ids() },
            "model": { "type": "string" }, "thinking_level": { "type": "string" },
            "permission_mode": { "type": "string" },
            "codex_permission_mode": { "type": "string" }, "source_note": { "type": "string" },
            "branch": { "type": "object", "properties": {
                "mode": { "type": "string", "enum": ["none", "new_project_branch", "new_worktree", "reuse_worktree"], "description": "Worktree strategy. Prefer new_worktree for independent implementation tasks." },
                "base": { "type": "string", "description": "Base branch for new_worktree/new_project_branch, commonly main." },
                "reuse_branch": { "type": "string", "description": "Existing branch to reuse when mode is reuse_worktree." }
            }},
            "follow": {
                "type": "object",
                "properties": {
                    "gates": { "type": "boolean", "default": true, "description": "Automatically steer permission, plan, and question gates to the parent." },
                    "completion": { "type": "boolean", "default": true, "description": "Automatically steer the child's first turn result to the parent as a <cadencr-reply>." }
                }
            },
            "link_to_current_session": { "type": "boolean" },
            "await_result": { "type": "boolean", "default": false }
        },
        "required": ["title"]
    })
}
fn document_schema(tool_name: &str, mut schema: Value) -> Value {
    let Some(properties) = schema["properties"].as_object_mut() else {
        return schema;
    };
    for (property, value) in properties {
        if value.get("description").is_none() {
            value["description"] = Value::String(property_description(tool_name, property));
        }
    }
    schema
}

#[cfg(test)]
mod tests {
    use super::tools;

    #[test]
    fn project_spawn_session_schema_exposes_branch_options() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_spawn_session")
            .expect("project_spawn_session tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["branch"]["type"], "object");
        assert_eq!(
            schema["properties"]["branch"]["properties"]["mode"]["enum"][2],
            "new_worktree"
        );
        assert_eq!(
            schema["properties"]["branch"]["properties"]["reuse_branch"]["type"],
            "string"
        );
        assert_eq!(schema["properties"]["follow"]["type"], "object");
        assert_eq!(
            schema["properties"]["follow"]["properties"]["completion"]["default"],
            true
        );
    }
    #[test]
    fn project_tool_schemas_document_every_input() {
        for tool in tools() {
            let schema = serde_json::to_value(&tool.input_schema).expect("schema json");
            let properties = schema["properties"].as_object().expect("properties");
            for (name, property) in properties {
                assert!(
                    property["description"]
                        .as_str()
                        .is_some_and(|value| !value.is_empty()),
                    "{}.{name} is missing a description",
                    tool.name
                );
            }
        }
    }
    #[test]
    fn project_spawn_session_schema_exposes_cross_project_targeting() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_spawn_session")
            .expect("project_spawn_session tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["project_id"]["type"], "number");
        assert_eq!(schema["properties"]["project_path"]["type"], "string");
        // Keep the advertised schema flat so MCP clients generate concrete
        // arguments instead of an opaque union. The control endpoint falls
        // back to the caller's own project when no selector is present.
        assert!(schema.get("anyOf").is_none());
        assert_eq!(schema["required"][0], "title");
        assert!(schema["description"]
            .as_str()
            .unwrap()
            .contains("project_id or project_path"));
        assert!(schema["properties"]["project_id"]["description"]
            .as_str()
            .unwrap()
            .contains("workspace_list_projects"));
        assert!(schema["properties"]["initial_message"]["description"]
            .as_str()
            .unwrap()
            .contains("instead of interpolating this message into source code"));
    }
    #[test]
    fn project_spawn_schema_guides_provider_and_model_values() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_spawn_session")
            .expect("project_spawn_session tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["provider"]["enum"][0], "claude_code");
        assert!(schema["properties"]["provider"]["description"]
            .as_str()
            .unwrap()
            .contains("codex_cli"));
        assert!(schema["properties"]["model"]["description"]
            .as_str()
            .unwrap()
            .contains("project_list_agent_providers"));
        assert_eq!(schema["properties"]["thinking_level"]["type"], "string");
        let thinking_description = schema["properties"]["thinking_level"]["description"]
            .as_str()
            .unwrap();
        assert!(thinking_description.contains("thinking_levels"));
        assert!(thinking_description.contains("target provider/model pair"));
        assert!(thinking_description.contains("default_thinking_level"));
    }
    #[test]
    fn project_create_schedule_is_advertised_with_its_rule_and_condition() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_create_schedule")
            .expect("project_create_schedule tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");
        assert_eq!(
            schema["required"],
            serde_json::json!(["prompt", "recurrence"])
        );
        assert_eq!(
            schema["properties"]["recurrence"]["properties"]["kind"]["enum"][1],
            "interval"
        );
        assert_eq!(schema["properties"]["condition"]["required"][0], "command");
        assert!(tool
            .description
            .as_deref()
            .unwrap()
            .contains("non-zero exit"));
    }
    #[test]
    fn schedule_management_tools_take_a_schedule_id_and_a_flat_patch() {
        let tools = tools();
        let schema = |name: &str| {
            let tool = tools.iter().find(|tool| tool.name == name).expect(name);
            serde_json::to_value(&tool.input_schema).expect("schema json")
        };
        let update = schema("project_update_schedule");
        assert_eq!(update["required"], serde_json::json!(["schedule_id"]));
        assert_eq!(update["properties"]["enabled"]["type"], "boolean");
        assert_eq!(update["properties"]["remove_condition"]["type"], "boolean");
        assert_eq!(
            update["properties"]["recurrence"]["properties"]["kind"]["enum"][0],
            "once"
        );
        assert_eq!(
            schema("project_delete_schedule")["required"],
            serde_json::json!(["schedule_id"])
        );
        assert!(schema("project_list_schedules")["properties"]
            .as_object()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn project_provider_discovery_tool_is_advertised() {
        assert!(tools()
            .iter()
            .any(|tool| tool.name == "project_list_agent_providers"));
    }
    #[test]
    fn inter_agent_delivery_defaults_to_reactive_steering() {
        let tools = tools();
        let send = tools
            .iter()
            .find(|tool| tool.name == "project_send_session_message")
            .unwrap();
        let schema = serde_json::to_value(&send.input_schema).unwrap();
        assert_eq!(
            schema["properties"]["delivery"]["default"],
            "steer_current_turn"
        );
        assert_eq!(schema["properties"]["delivery"]["enum"][1], "next_turn");
        let send_description = send.description.as_deref().unwrap();
        assert!(send_description.contains("steers the active target turn"));

        for name in [
            "project_read_session_tail",
            "project_get_session_status",
            "project_list_pending_gates",
        ] {
            let tool = tools.iter().find(|tool| tool.name == name).unwrap();
            let description = tool.description.as_deref().unwrap();
            assert!(description.contains("poll") || description.contains("Poll"));
        }
    }
    #[test]
    fn project_read_search_link_and_compare_schemas_keep_expected_inputs() {
        let tools = tools();
        let schema_for = |name: &str| {
            let tool = tools.iter().find(|tool| tool.name == name).expect(name);
            serde_json::to_value(&tool.input_schema).expect("schema json")
        };

        let list = schema_for("project_list_sessions");
        assert_eq!(list["properties"]["cursor"]["type"], "object");
        assert_eq!(
            list["properties"]["cursor"]["properties"]["before_started_at"]["type"],
            "string"
        );
        let search = schema_for("project_find_related_sessions");
        assert_eq!(search["properties"]["query"]["type"], "string");
        assert_eq!(search["properties"]["snippet_chars"]["type"], "number");
        assert_eq!(search["required"][0], "query");
        let tail = schema_for("project_read_session_tail");
        assert_eq!(tail["properties"]["session_id"]["type"], "number");
        assert_eq!(tail["properties"]["after_message_id"]["type"], "number");
        assert_eq!(
            tail["properties"]["include_tool_details"]["type"],
            "boolean"
        );
        assert_eq!(tail["required"][0], "session_id");
        let link = schema_for("project_link_sessions");
        assert_eq!(link["properties"]["target_session_id"]["type"], "number");
        assert_eq!(link["properties"]["link_type"]["enum"][2], "referenced");
        assert_eq!(link["required"][0], "target_session_id");
        let worktree = schema_for("project_get_worktree_status");
        assert_eq!(worktree["properties"]["session_id"]["type"], "number");

        let compare = schema_for("project_compare_sessions");
        assert_eq!(compare["properties"]["left_session_id"]["type"], "number");
        assert_eq!(compare["properties"]["right_session_id"]["type"], "number");
        assert_eq!(compare["required"][0], "left_session_id");
        assert_eq!(compare["required"][1], "right_session_id");
    }
}
