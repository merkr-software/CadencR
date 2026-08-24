use std::future::Future;
use std::sync::Arc;

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, ErrorData, ListToolsResult,
        PaginatedRequestParams, ServerInfo, Tool,
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

const WORKSPACE_TOOL_NAMES: [&str; 6] = [
    "workspace_list_projects",
    "workspace_read_session",
    "workspace_read_sessions",
    "workspace_session_graph",
    "workspace_recent_activity",
    "workspace_send_session_message",
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
        "workspace_send_session_message" => {
            "Send a provenance-tracked message to a session in any CadencR project. Delivery steers the active target turn by default; request next_turn explicitly only when delayed handling is intentional."
        }
        _ => "Search CadencR workspace history.",
    }
}

fn tool_schema(name: &str) -> serde_json::Value {
    let schema = match name {
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
        "workspace_send_session_message" => super::send_message_schema::schema(
            "Target session id in any CadencR project, including a cross-project worker.",
        ),
        _ => json!({ "type": "object", "properties": {} }),
    };
    document_schema(name, schema)
}

fn document_schema(tool_name: &str, mut schema: serde_json::Value) -> serde_json::Value {
    let Some(properties) = schema["properties"].as_object_mut() else {
        return schema;
    };
    for (property, value) in properties {
        if value.get("description").is_none() {
            value["description"] =
                serde_json::Value::String(property_description(tool_name, property));
        }
    }
    schema
}

fn property_description(tool_name: &str, property: &str) -> String {
    match property {
        "session_id" => "Session id to read or use as the graph anchor.".into(),
        "query" => "Full-text search query for matching session messages.".into(),
        "roles" => "Optional message role filters such as user, assistant, or tool.".into(),
        "message_types" => {
            "Optional message_type filters such as text, tool_call, or tool_result.".into()
        }
        "after_message_id" => "Return messages after this message id.".into(),
        "before_message_id" => "Return messages before this message id.".into(),
        "include_metadata" => "Include project/session/message provenance metadata.".into(),
        "limit" => {
            "Maximum number of rows/messages to return; tools clamp oversized values.".into()
        }
        "project_ids" => "Restrict search to these project ids.".into(),
        "providers" => {
            "Restrict sessions by canonical provider id, e.g. claude_code, codex_cli, cursor, opencode."
                .into()
        }
        "models" => "Restrict sessions by persisted model id.".into(),
        "statuses" => "Restrict sessions by status, e.g. running, paused, completed.".into(),
        "tool_names" => "Restrict results to messages using these tool names.".into(),
        "created_after" => "Only include messages created at or after this timestamp.".into(),
        "created_before" => "Only include messages created before this timestamp.".into(),
        "cursor" => "Cursor object returned by the previous page.".into(),
        "snippet_chars" => "Maximum characters to include in each result snippet.".into(),
        _ => format!("Input parameter `{property}` for {tool_name}."),
    }
}

impl ServerHandler for WorkspaceServer {
    fn get_info(&self) -> ServerInfo {
        server_info("cadencr-workspace")
    }

    fn supported_protocol_versions(
        &self,
    ) -> std::borrow::Cow<'static, [rmcp::model::ProtocolVersion]> {
        super::supported_protocol_versions()
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        std::future::ready(Ok(ListToolsResult::with_all_items(tools())))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + Send + '_ {
        async move {
            let args = request
                .arguments
                .as_ref()
                .map(|m| serde_json::Value::Object(m.clone()))
                .unwrap_or(serde_json::Value::Null);
            Ok(
                run_workspace_tool(request.name.as_ref(), args, self.ctx.clone())
                    .await
                    .into(),
            )
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

    #[test]
    fn workspace_send_message_schema_supports_cross_project_follow_up_options() {
        let tools = tools();
        let tool = tools
            .iter()
            .find(|tool| tool.name == "workspace_send_session_message")
            .expect("workspace_send_session_message tool");
        let schema = serde_json::to_value(&tool.input_schema).expect("schema json");

        let required = schema["required"].as_array().expect("required fields");
        assert!(required.iter().any(|value| value == "target_session_id"));
        assert!(required.iter().any(|value| value == "message"));
        assert_eq!(
            schema["properties"]["delivery"]["default"],
            "steer_current_turn"
        );
        let reply_modes = schema["properties"]["reply"]["enum"]
            .as_array()
            .expect("reply modes");
        assert!(reply_modes.iter().any(|value| value == "on_turn_end"));
        assert!(schema["properties"]["target_session_id"]["description"]
            .as_str()
            .is_some_and(|description| description.contains("any CadencR project")));
        assert!(
            schema["properties"]["link_to_current_session"]["description"]
                .as_str()
                .is_some_and(|description| description.contains("messaged session link"))
        );
        assert!(tool
            .description
            .as_deref()
            .unwrap()
            .contains("any CadencR project"));
    }

    #[test]
    fn workspace_tool_schemas_document_every_input() {
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
}
