use std::future::Future;
use std::sync::Arc;

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, ErrorData, ListToolsResult,
        PaginatedRequestParams, ServerInfo,
    },
    service::{RequestContext, RoleServer},
};

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::project::run_project_tool;

use super::project_schema::tools;
use super::server_info;

pub struct ProjectServer {
    ctx: Arc<McpContext>,
}

impl ProjectServer {
    pub fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
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
                run_project_tool(request.name.as_ref(), args, self.ctx.clone())
                    .await
                    .into(),
            )
        }
    }
}
