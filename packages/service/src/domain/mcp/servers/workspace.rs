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
use crate::domain::mcp::tools::workspace::run_workspace_tool;

use super::server_info;

pub struct WorkspaceServer {
    ctx: Arc<McpContext>,
}

impl WorkspaceServer {
    pub fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
    }
}

const WORKSPACE_TOOL_NAMES: [&str; 5] = [
    "workspace_list_projects",
    "workspace_read_session",
    "workspace_read_sessions",
    "workspace_session_graph",
    "workspace_recent_activity",
];

fn make_tool(name: &'static str, description: &'static str, schema: serde_json::Value) -> Tool {
    let obj: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(schema).expect("schema must be an object");
    Tool::new(name, description, obj)
}

fn tools() -> Vec<Tool> {
    WORKSPACE_TOOL_NAMES
        .into_iter()
        .map(|name| make_tool(name, tool_description(name), tool_schema(name)))
        .collect()
}

fn tool_description(name: &str) -> &'static str {
    match name {
        "workspace_list_projects" => "List CadencR projects visible to workspace MCP search.",
        "workspace_read_session" => "Read a CadencR session by id with project metadata.",
        "workspace_read_sessions" => {
            "Search CadencR sessions and messages across projects with filters."
        }
        "workspace_session_graph" => {
            "Read the spawn/reference/message graph between CadencR sessions."
        }
        "workspace_recent_activity" => "Read recent CadencR activity across projects.",
        _ => "Search CadencR workspace history.",
    }
}

fn tool_schema(name: &str) -> serde_json::Value {
    match name {
        "workspace_read_session" => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "number" },
                "query": { "type": "string" },
                "roles": { "type": "array", "items": { "type": "string" } },
                "message_types": { "type": "array", "items": { "type": "string" } },
                "after_message_id": { "type": "number" },
                "before_message_id": { "type": "number" },
                "include_metadata": { "type": "boolean" },
                "limit": { "type": "number" }
            },
            "required": ["session_id"]
        }),
        "workspace_read_sessions" => json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "project_ids": { "type": "array", "items": { "type": "number" } },
                "roles": { "type": "array", "items": { "type": "string" } },
                "message_types": { "type": "array", "items": { "type": "string" } },
                "providers": { "type": "array", "items": { "type": "string" } },
                "models": { "type": "array", "items": { "type": "string" } },
                "statuses": { "type": "array", "items": { "type": "string" } },
                "tool_names": { "type": "array", "items": { "type": "string" } },
                "created_after": { "type": "string" },
                "created_before": { "type": "string" },
                "limit": { "type": "number" },
                "cursor": {
                    "type": "object",
                    "properties": {
                        "before_message_id": { "type": "number" }
                    }
                },
                "snippet_chars": { "type": "number" }
            }
        }),
        "workspace_session_graph" => json!({
            "type": "object",
            "properties": {
                "session_id": { "type": "number" },
                "limit": { "type": "number" }
            }
        }),
        "workspace_recent_activity" => json!({
            "type": "object",
            "properties": {
                "limit": { "type": "number" },
                "snippet_chars": { "type": "number" }
            }
        }),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

impl ServerHandler for WorkspaceServer {
    fn get_info(&self) -> ServerInfo {
        server_info("cadencr-workspace")
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
            Ok(run_workspace_tool(request.name.as_ref(), args, self.ctx.clone()).await)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::tools;

    #[test]
    fn workspace_read_sessions_schema_exposes_all_filter_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "workspace_read_sessions")
            .expect("workspace_read_sessions tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["models"]["items"]["type"], "string");
        assert_eq!(
            schema["properties"]["tool_names"]["items"]["type"],
            "string"
        );
        assert_eq!(schema["properties"]["cursor"]["type"], "object");
        assert_eq!(
            schema["properties"]["cursor"]["properties"]["before_message_id"]["type"],
            "number"
        );
    }

    #[test]
    fn workspace_read_session_schema_exposes_pagination_and_filter_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "workspace_read_session")
            .expect("workspace_read_session tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["query"]["type"], "string");
        assert_eq!(schema["properties"]["roles"]["items"]["type"], "string");
        assert_eq!(
            schema["properties"]["message_types"]["items"]["type"],
            "string"
        );
        assert_eq!(schema["properties"]["after_message_id"]["type"], "number");
        assert_eq!(schema["properties"]["before_message_id"]["type"], "number");
    }

    #[test]
    fn workspace_session_graph_schema_exposes_session_filter() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "workspace_session_graph")
            .expect("workspace_session_graph tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["session_id"]["type"], "number");
        assert_eq!(schema["properties"]["limit"]["type"], "number");
    }

    #[test]
    fn workspace_recent_activity_schema_exposes_limit_inputs() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "workspace_recent_activity")
            .expect("workspace_recent_activity tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        assert_eq!(schema["properties"]["limit"]["type"], "number");
        assert_eq!(schema["properties"]["snippet_chars"]["type"], "number");
    }
}
