use rmcp::model::Tool;
use serde_json::{json, Value};

use crate::domain::agents::providers::{provider_alias_metadata, valid_provider_ids};
const PROJECT_TOOL_NAMES: [&str; 13] = [
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

fn tool_description(name: &str) -> &'static str {
    match name {
        "project_list_sessions" => "List recent CadencR sessions in the current project. Use before spawning to avoid duplicate work.",
        "project_read_session" => {
            "Read a current-project session with pagination and filters. Use include_tool_details only when tool payloads are needed."
        }
        "project_read_session_tail" => {
            "Poll new messages from a current-project session after a cursor."
        }
        "project_get_session_status" => "Inspect live or persisted status for one current-project session.",
        "project_get_worktree_status" => {
            "Inspect worktree path, branch, and dirty-file ownership for current-project sessions."
        }
        "project_find_related_sessions" => {
            "Search same-project session history for related work before spawning or editing."
        }
        "project_compare_sessions" => "Compare two current-project sessions and their worktree status.",
        "project_link_sessions" => {
            "Record an explicit relationship between current-project sessions."
        }
        "project_list_agent_providers" => {
            "List canonical CadencR provider ids, common aliases, and model guidance for project_spawn_session."
        }
        "project_spawn_session" => {
            "Create another CadencR session in a target project. You MUST specify the target with project_id or project_path (call workspace_list_projects to list projects, then pass the caller's own project id to spawn in the current project). Targeting a different project is useful when related codebases live as separate CadencR projects. Use canonical provider ids; call project_list_agent_providers when unsure."
        }
        "project_send_session_message" => {
            "Send a provenance-tracked user message to another current-project session."
        }
        "project_list_pending_gates" => "Recover or reconcile the current pending gate for a linked child session. A live <cadencr-gate> notification already includes the complete request id, kind, options, and tool/question payload, so do not list again unless recovery or stale-state verification is needed.",
        "project_respond_gate" => "Answer a linked child session's pending gate. Use the session id, request id, kind, and complete payload directly from the live <cadencr-gate> notification.",
        _ => "Coordinate CadencR sessions in the current project.",
    }
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
        "project_send_session_message" => json!({
            "type": "object",
            "properties": {
                "target_session_id": { "type": "number" },
                "message": { "type": "string" },
                "delivery": { "type": "string", "enum": ["send_now", "queue_if_busy", "reject_if_busy"] },
                "reply": { "type": "string", "enum": ["none", "on_turn_end"], "default": "none" },
                "source_note": { "type": "string" },
                "link_to_current_session": { "type": "boolean" }
            },
            "required": ["target_session_id", "message"]
        }),
        "project_list_pending_gates" | "project_respond_gate" => {
            super::project_gate_schema::schema(name)
        }
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
        "properties": {
            "title": { "type": "string" }, "initial_message": { "type": "string" },
            "project_id": { "type": "number" }, "project_path": { "type": "string" },
            "provider": { "type": "string", "enum": valid_provider_ids() },
            "model": { "type": "string" }, "permission_mode": { "type": "string" },
            "codex_permission_mode": { "type": "string" }, "source_note": { "type": "string" },
            "branch": { "type": "object", "properties": {
                "mode": { "type": "string", "enum": ["none", "new_project_branch", "new_worktree", "reuse_worktree"], "description": "Worktree strategy. Prefer new_worktree for independent implementation tasks." },
                "base": { "type": "string", "description": "Base branch for new_worktree/new_project_branch, commonly main." },
                "reuse_branch": { "type": "string", "description": "Existing branch to reuse when mode is reuse_worktree." }
            }},
            "link_to_current_session": { "type": "boolean" },
            "await_result": { "type": "boolean", "default": false }
        },
        "required": ["title"],
        "anyOf": [{ "required": ["project_id"] }, { "required": ["project_path"] }]
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

fn property_description(tool_name: &str, property: &str) -> String {
    match (tool_name, property) {
        ("project_spawn_session", "provider") => {
            "Canonical provider id: claude_code, codex_cli, or opencode. Common aliases are normalized, but canonical ids are preferred.".into()
        }
        ("project_spawn_session", "project_id") => {
            "Target project id for the new session (required unless project_path is given). Pass the caller's own project id to spawn in the current project, or another project's id to spawn there. Get ids from workspace_list_projects.".into()
        }
        ("project_spawn_session", "project_path") => {
            "Target project root path (alternative to project_id). Must exactly match a registered project's path; see workspace_list_projects. If both project_id and project_path are given they must agree.".into()
        }
        ("project_spawn_session", "model") => {
            let claude_guidance = provider_alias_metadata("claude_code")
                .map(|metadata| metadata.model_guidance)
                .unwrap_or("Claude Code uses catalog aliases such as opus or sonnet.");
            format!(
                "Provider-specific model id. {claude_guidance} Codex uses gpt-* ids; OpenCode often uses provider/model ids. Call project_list_agent_providers when unsure."
            )
        }
        ("project_send_session_message", "delivery") => {
            "send_now sends immediately, queue_if_busy queues for running targets, reject_if_busy fails if the target is busy.".into()
        }
        (_, "session_id") => "Target session id in the current project.".into(),
        (_, "target_session_id") => "Current-project session id receiving the operation.".into(),
        (_, "limit") => "Maximum number of rows/messages to return; tools clamp oversized values.".into(),
        (_, "cursor") => "Cursor object returned by the previous page.".into(),
        (_, "query") => "Full-text search query used to find matching messages.".into(),
        (_, "roles") => "Optional message role filters such as user, assistant, or tool.".into(),
        (_, "message_types") => "Optional message_type filters such as text, tool_call, or tool_result.".into(),
        (_, "after_message_id") => "Return messages after this message id.".into(),
        (_, "before_message_id") => "Return messages before this message id.".into(),
        (_, "include_tool_details") => "Include full tool payload content; omit unless needed because payloads can be large.".into(),
        (_, "include_metadata") => "Include provenance/origin metadata for returned messages.".into(),
        (_, "snippet_chars") => "Maximum characters to include in each search result snippet.".into(),
        (_, "left_session_id") => "First current-project session id to compare.".into(),
        (_, "right_session_id") => "Second current-project session id to compare.".into(),
        (_, "link_type") => "Relationship type to record between source and target sessions.".into(),
        (_, "note" | "source_note") => "Short provenance note explaining why this relationship or action exists.".into(),
        (_, "title") => "Title for the newly created session/conversation.".into(),
        (_, "initial_message") => "Initial user message sent to the spawned session after creation.".into(),
        (_, "permission_mode") => "Legacy/generic permission mode to persist for the spawned session.".into(),
        (_, "codex_permission_mode") => "Codex access mode, for codex_cli sessions: default, autoReview, or fullAccess.".into(),
        (_, "branch") => "Worktree/branch creation options for the spawned session.".into(),
        (_, "link_to_current_session") => "Whether to create a spawned/messaged link from the current session; defaults to true.".into(),
        (_, "message") => "User message content to send to the target session.".into(),
        _ => format!("Input parameter `{property}` for {tool_name}."),
    }
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
        // A target project is mandatory: either project_id or project_path.
        assert_eq!(schema["anyOf"][0]["required"][0], "project_id");
        assert_eq!(schema["anyOf"][1]["required"][0], "project_path");
        assert!(schema["properties"]["project_id"]["description"]
            .as_str()
            .unwrap()
            .contains("workspace_list_projects"));
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
    }

    #[test]
    fn project_provider_discovery_tool_is_advertised() {
        let tools = tools();
        assert!(tools
            .iter()
            .any(|tool| tool.name == "project_list_agent_providers"));
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
