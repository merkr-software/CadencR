use std::future::Future;
use std::sync::Arc;

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResult, ErrorData, ListToolsResult, PaginatedRequestParams,
        ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
};
use serde_json::json;

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::project::run_project_tool;

use super::server_info;

pub struct ProjectServer {
    ctx: Arc<McpContext>,
}

impl ProjectServer {
    pub fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
    }
}

const PROJECT_TOOL_NAMES: [&str; 10] = [
    "project_list_sessions",
    "project_read_session",
    "project_read_session_tail",
    "project_get_session_status",
    "project_get_worktree_status",
    "project_find_related_sessions",
    "project_compare_sessions",
    "project_link_sessions",
    "project_spawn_session",
    "project_send_session_message",
];

fn make_tool(name: &'static str, description: &'static str, schema: serde_json::Value) -> Tool {
    let obj: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(schema).expect("schema must be an object");
    Tool::new(name, description, obj)
}

fn tools() -> Vec<Tool> {
    PROJECT_TOOL_NAMES
        .into_iter()
        .map(|name| make_tool(name, tool_description(name), tool_schema(name)))
        .collect()
}

fn tool_description(name: &str) -> &'static str {
    match name {
        "project_list_sessions" => "List CadencR sessions in the current project.",
        "project_read_session" => {
            "Read a current-project session with pagination and optional filters."
        }
        "project_read_session_tail" => {
            "Read new messages from a current-project session after a cursor."
        }
        "project_get_session_status" => "Inspect the live or persisted status of a session.",
        "project_get_worktree_status" => {
            "Inspect worktree and branch ownership for current-project sessions."
        }
        "project_find_related_sessions" => {
            "Search same-project session history for related messages."
        }
        "project_compare_sessions" => "Compare two current-project sessions.",
        "project_link_sessions" => {
            "Record an explicit relationship between current-project sessions."
        }
        "project_spawn_session" => "Create another CadencR session in the current project.",
        "project_send_session_message" => {
            "Send a provenance-tracked user message to another current-project session."
        }
        _ => "Coordinate CadencR sessions in the current project.",
    }
}

fn tool_schema(name: &str) -> serde_json::Value {
    match name {
        "project_list_sessions" => json!({
            "type": "object",
            "properties": {
                "limit": { "type": "number" },
                "cursor": {
                    "type": "object",
                    "properties": {
                        "before_session_id": { "type": "number" },
                        "before_started_at": { "type": "string" }
                    }
                }
            }
        }),
        "project_read_session" => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "number" },
                "query": { "type": "string" },
                "roles": { "type": "array", "items": { "type": "string" } },
                "message_types": { "type": "array", "items": { "type": "string" } },
                "after_message_id": { "type": "number" },
                "before_message_id": { "type": "number" },
                "limit": { "type": "number" },
                "include_tool_details": { "type": "boolean" },
                "include_metadata": { "type": "boolean" }
            },
            "required": ["session_id"]
        }),
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
        "project_spawn_session" => json!({
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "initial_message": { "type": "string" },
                "provider": { "type": "string" },
                "model": { "type": "string" },
                "permission_mode": { "type": "string" },
                "codex_permission_mode": { "type": "string" },
                "source_note": { "type": "string" },
                "branch": {
                    "type": "object",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["none", "new_project_branch", "new_worktree", "reuse_worktree"]
                        },
                        "base": { "type": "string" },
                        "reuse_branch": { "type": "string" }
                    }
                },
                "link_to_current_session": { "type": "boolean" }
            },
            "required": ["title"]
        }),
        "project_send_session_message" => json!({
            "type": "object",
            "properties": {
                "target_session_id": { "type": "number" },
                "message": { "type": "string" },
                "delivery": { "type": "string", "enum": ["send_now", "queue_if_busy", "reject_if_busy"] },
                "source_note": { "type": "string" },
                "link_to_current_session": { "type": "boolean" }
            },
            "required": ["target_session_id", "message"]
        }),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

impl ServerHandler for ProjectServer {
    fn get_info(&self) -> ServerInfo {
        server_info("cadencr-project")
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        std::future::ready(Ok(ListToolsResult {
            meta: None,
            tools: tools(),
            next_cursor: None,
        }))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResult, ErrorData>> + Send + '_ {
        async move {
            let args = request
                .arguments
                .as_ref()
                .map(|m| serde_json::Value::Object(m.clone()))
                .unwrap_or(serde_json::Value::Null);
            Ok(run_project_tool(request.name.as_ref(), args, self.ctx.clone()).await)
        }
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
    fn project_list_sessions_schema_exposes_cursor_pagination_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_list_sessions")
            .expect("project_list_sessions tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["limit"]["type"], "number");
        assert_eq!(schema["properties"]["cursor"]["type"], "object");
        assert_eq!(
            schema["properties"]["cursor"]["properties"]["before_session_id"]["type"],
            "number"
        );
        assert_eq!(
            schema["properties"]["cursor"]["properties"]["before_started_at"]["type"],
            "string"
        );
    }

    #[test]
    fn project_find_related_sessions_schema_exposes_search_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_find_related_sessions")
            .expect("project_find_related_sessions tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["query"]["type"], "string");
        assert_eq!(schema["properties"]["limit"]["type"], "number");
        assert_eq!(schema["properties"]["snippet_chars"]["type"], "number");
        assert_eq!(schema["required"][0], "query");
    }

    #[test]
    fn project_read_session_tail_schema_exposes_polling_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_read_session_tail")
            .expect("project_read_session_tail tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["session_id"]["type"], "number");
        assert_eq!(schema["properties"]["after_message_id"]["type"], "number");
        assert_eq!(schema["properties"]["limit"]["type"], "number");
        assert_eq!(schema["properties"]["include_metadata"]["type"], "boolean");
        assert_eq!(
            schema["properties"]["include_tool_details"]["type"],
            "boolean"
        );
        assert_eq!(schema["required"][0], "session_id");
    }

    #[test]
    fn project_link_sessions_schema_exposes_link_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_link_sessions")
            .expect("project_link_sessions tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["target_session_id"]["type"], "number");
        assert_eq!(schema["properties"]["link_type"]["enum"][2], "referenced");
        assert_eq!(schema["properties"]["note"]["type"], "string");
        assert_eq!(schema["required"][0], "target_session_id");
    }

    #[test]
    fn project_get_worktree_status_schema_exposes_session_filter() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_get_worktree_status")
            .expect("project_get_worktree_status tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["session_id"]["type"], "number");
    }

    #[test]
    fn project_compare_sessions_schema_exposes_pair_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "project_compare_sessions")
            .expect("project_compare_sessions tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["left_session_id"]["type"], "number");
        assert_eq!(schema["properties"]["right_session_id"]["type"], "number");
        assert_eq!(schema["required"][0], "left_session_id");
        assert_eq!(schema["required"][1], "right_session_id");
    }
}
